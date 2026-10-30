'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { db, get, all, run, nowIso } = require('../src/database');

const DATA = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/expanded-synthetic-dataset-v2.json'), 'utf8'));
if (!DATA.synthetic || !DATA.entities) throw new Error('Refusing to import a dataset not explicitly marked synthetic.');
const IMPORT_KEY = 'expanded-synthetic-dataset-v2-350';
db.exec(`CREATE TABLE IF NOT EXISTS dataset_imports(dataset_key TEXT PRIMARY KEY, imported_at TEXT NOT NULL, source_label TEXT NOT NULL);`);
const existing = get('SELECT dataset_key FROM dataset_imports WHERE dataset_key=?', IMPORT_KEY);
if (existing) {
  console.log(`Dataset ${IMPORT_KEY} was already imported. No duplicate rows created.`);
  db.close();
  process.exit(0);
}
const E = DATA.entities;
const requiredSheets = ['suppliers','warehouses','products','carriers','inventory','shipments','shipment_items','orders','order_items','disruptions','order_risks','recovery_plans','users','webhook_events','notifications','approvals','audit_logs'];
for (const name of requiredSheets) if (!Array.isArray(E[name]) || E[name].length !== 350) throw new Error(`Expected exactly 350 records in ${name}.`);

db.exec(`
CREATE TABLE IF NOT EXISTS dataset_imports(dataset_key TEXT PRIMARY KEY, imported_at TEXT NOT NULL, source_label TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products(product_code TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, category TEXT, unit_cost REAL, unit_weight_kg REAL, is_active INTEGER NOT NULL, data_origin TEXT NOT NULL DEFAULT 'synthetic');
CREATE TABLE IF NOT EXISTS carriers(carrier_code TEXT PRIMARY KEY, name TEXT NOT NULL, service_type TEXT, tracking_prefix TEXT, data_origin TEXT NOT NULL DEFAULT 'synthetic');
CREATE TABLE IF NOT EXISTS source_order_risks(risk_code TEXT PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES customer_orders(id), disruption_id INTEGER NOT NULL REFERENCES disruptions(id), source_risk_score REAL, source_risk_level TEXT, source_explanation TEXT, assessed_at TEXT, data_origin TEXT NOT NULL DEFAULT 'synthetic');
CREATE TABLE IF NOT EXISTS synthetic_reference_records(source_type TEXT NOT NULL,source_id TEXT NOT NULL,payload_json TEXT NOT NULL,archived_at TEXT NOT NULL,PRIMARY KEY(source_type,source_id));
`);
for (const table of ['suppliers','warehouses','inventories','shipments','shipment_items','customer_orders','order_items','disruptions','recovery_plans','recovery_actions','approvals','audit_logs','webhook_events','notifications']) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === 'data_origin')) db.exec(`ALTER TABLE ${table} ADD COLUMN data_origin TEXT NOT NULL DEFAULT 'operational'`);
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_source_record_id ON shipments(source_record_id); CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_source_record_id ON inventories(source_record_id);`);
const by = (rows, key) => new Map(rows.map(x => [String(x[key]), x]));
const supSrc = by(E.suppliers,'supplier_id'), whSrc = by(E.warehouses,'warehouse_id'), prodSrc = by(E.products,'product_id'), carrierSrc = by(E.carriers,'carrier_id');
const mapSup = new Map(), mapWh = new Map(), mapProd = new Map(), mapCarrier = new Map(), mapShip = new Map(), mapOrder = new Map(), mapDis = new Map(), mapInv = new Map();
const clean = v => v == null || v === '' ? null : v;
const num = (v, fallback=0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const isoDate = v => {
  if (!v) return null;
  const s = String(v);
  return s.length === 10 ? `${s}T00:00:00.000Z` : s;
};
const status = (v, map, fallback) => map[String(v || '').toUpperCase()] || fallback;
const shipmentStatus = v => status(v,{IN_TRANSIT:'In Transit',DELIVERED:'Delivered',DELAYED:'Delayed',PENDING_PICKUP:'Scheduled'},'Scheduled');
const orderStatus = v => status(v,{CONFIRMED:'Pending',ALLOCATED:'Allocated',PROCESSING:'Processing',ON_HOLD:'At Risk'},'Pending');
const disruptionStatus = v => status(v,{ACTIVE:'Active',INVESTIGATING:'Investigating',RESOLVED:'Resolved'},'Active');
const severity = v => status(v,{CRITICAL:'Critical',HIGH:'High',MEDIUM:'Medium',LOW:'Low'},'Medium');
const planStatus = v => status(v,{PROPOSED:'Draft',PENDING_APPROVAL:'Pending Approval',APPROVED:'Approved',REJECTED:'Rejected',EXECUTED:'Executed',FAILED:'Execution Failed'},'Draft');
const decisionStatus = v => status(v,{PENDING:'Pending',APPROVED:'Approved',REJECTED:'Rejected'},'Pending');
const roleUser = get("SELECT id FROM users WHERE email='hub@disruptioniq.local' AND role='HUB_INCHARGE' AND is_active=1");
if (!roleUser) throw new Error('Active HUB_INCHARGE development account is required before importing the synthetic dataset.');

db.exec('BEGIN IMMEDIATE');
try {
  const insert = (sql, ...args) => { try { return run(sql, ...args); } catch (error) { console.error('Failed import statement:', sql, '\\nValues:', args); throw error; } };
  // Master data
  for (const x of E.suppliers) {
    insert(`INSERT OR IGNORE INTO suppliers(code,name,country,city,state,reliability_score,lead_time_days,contact_email,is_active,created_at,region,risk_score,exposure,data_origin)
      VALUES(?,?,NULL,?,?,?,?,?,?,?,NULL,0,'Synthetic dataset supplier','synthetic')`,
      x.supplier_id,x.supplier_name,x.city,x.state,Math.max(0,Math.min(1,num(x.reliability_score,85)/100)),num(x.lead_time_days,7),clean(x.email),String(x.status||'').toUpperCase()==='ACTIVE'?1:0,nowIso());
    mapSup.set(x.supplier_id,get('SELECT id FROM suppliers WHERE code=?',x.supplier_id).id);
  }
  for (const x of E.warehouses) {
    insert(`INSERT OR IGNORE INTO warehouses(code,name,location,capacity_sqm,current_utilization,capacity_units,is_active,created_at,data_origin)
      VALUES(?,?,?,0,0,?,?,?,'synthetic')`,x.warehouse_id,x.warehouse_name,`${x.city}, ${x.state}`,num(x.capacity_units),String(x.status||'').toUpperCase()==='ACTIVE'?1:0,nowIso());
    mapWh.set(x.warehouse_id,get('SELECT id FROM warehouses WHERE code=?',x.warehouse_id).id);
  }
  for (const x of E.products) {
    insert(`INSERT OR IGNORE INTO products(product_code,sku,name,category,unit_cost,unit_weight_kg,is_active,data_origin) VALUES(?,?,?,?,?,?,?,'synthetic')`,
      x.product_id,x.sku,x.product_name,x.category,num(x.unit_cost_inr),num(x.unit_weight_kg),x.active?1:0);
    mapProd.set(x.product_id,x);
  }
  for (const x of E.carriers) {
    insert(`INSERT OR IGNORE INTO carriers(carrier_code,name,service_type,tracking_prefix,data_origin) VALUES(?,?,?,?, 'synthetic')`,x.carrier_id,x.carrier_name,x.service_type,x.tracking_prefix);
    mapCarrier.set(x.carrier_id,x);
  }
  // Inventory and shipments
  for (const x of E.inventory) {
    const wh=mapWh.get(x.warehouse_id), product=mapProd.get(x.product_id);
    if (!wh || !product) throw new Error(`Invalid inventory relationship ${x.inventory_id}`);
    insert(`INSERT OR IGNORE INTO inventories(warehouse_id,sku,item_name,category,quantity,reserved_quantity,reorder_point,unit_cost,updated_at,data_origin,source_record_id)
      VALUES(?,?,?,?,?,?,?,?,?,'synthetic',?)`,wh,product.sku,product.product_name,product.category,num(x.on_hand_qty),num(x.reserved_qty),num(x.reorder_level),num(product.unit_cost_inr),isoDate(x.last_counted_at)||nowIso(),x.inventory_id);
    mapInv.set(x.inventory_id,get('SELECT id FROM inventories WHERE warehouse_id=? AND sku=?',wh,product.sku).id);
  }
  for (const x of E.shipments) {
    const supplier=mapSup.get(x.supplier_id), wh=mapWh.get(x.destination_warehouse_id), carrier=mapCarrier.get(x.carrier_id);
    if (!supplier || !wh || !carrier) throw new Error(`Invalid shipment relationship ${x.shipment_id}`);
    const supplierRow=get('SELECT city FROM suppliers WHERE id=?',supplier), warehouseRow=get('SELECT location FROM warehouses WHERE id=?',wh);
    insert(`INSERT OR IGNORE INTO shipments(tracking_number,supplier_id,destination_warehouse_id,carrier,transport_mode,status,origin_city,destination_city,estimated_departure,actual_departure,estimated_arrival,actual_arrival,created_at,ui_status,risk_score,progress,unit_count,eta_label,data_origin,source_record_id,carrier_code)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'synthetic',?,?)`,
      x.tracking_number,supplier,wh,carrier.carrier_name,carrier.service_type,shipmentStatus(x.status),supplierRow.city,warehouseRow.location,null,isoDate(x.dispatch_date),isoDate(x.expected_arrival_date),isoDate(x.actual_arrival_date),isoDate(x.last_event_at)||nowIso(),shipmentStatus(x.status),0,x.actual_arrival_date?100:shipmentStatus(x.status)==='Delivered'?100:0,0,null,x.shipment_id,x.carrier_id);
    mapShip.set(x.shipment_id,get('SELECT id FROM shipments WHERE tracking_number=?',x.tracking_number).id);
  }
  for (const x of E.shipment_items) {
    const ship=mapShip.get(x.shipment_id), product=mapProd.get(x.product_id);
    if(!ship||!product)throw new Error(`Invalid shipment item relationship ${x.shipment_id}/${x.product_id}`);
    insert(`INSERT INTO shipment_items(shipment_id,sku,item_name,quantity,data_origin) VALUES(?,?,?,?, 'synthetic')`,ship,product.sku,product.product_name,num(x.quantity,1));
    insert(`UPDATE shipments SET unit_count=unit_count+? WHERE id=?`,num(x.quantity),ship);
  }
  // Orders and line items
  for (const x of E.orders) {
    const wh=mapWh.get(x.warehouse_id);if(!wh)throw new Error(`Invalid order warehouse ${x.order_id}`);
    insert(`INSERT OR IGNORE INTO customer_orders(order_number,customer_name,customer_tier,status,priority,total_value,assigned_warehouse_id,order_date,delivery_deadline,data_origin)
      VALUES(?,?,'Standard',?,?,?,?,?,?,'synthetic')`,x.order_id,x.customer_name,orderStatus(x.status),String(x.priority||'MEDIUM').toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()),num(x.order_value_inr),wh,isoDate(x.order_date)||nowIso(),isoDate(x.promised_delivery_date));
    mapOrder.set(x.order_id,get('SELECT id FROM customer_orders WHERE order_number=?',x.order_id).id);
  }
  for (const x of E.order_items) {
    const order=mapOrder.get(x.order_id), product=mapProd.get(x.product_id);
    if(!order||!product)throw new Error(`Invalid order item relationship ${x.order_id}/${x.product_id}`);
    insert(`INSERT INTO order_items(order_id,sku,item_name,quantity,unit_price,data_origin,unit_price_available) VALUES(?,?,?,?,0,'synthetic',0)`,order,product.sku,product.product_name,num(x.quantity,1));
  }
  // Disruptions linked to source entities and their affected shipments/hubs.
  for (const x of E.disruptions) {
    let ship=null, warehouse=null, supplier=null;
    if(x.source_entity_type==='SHIPMENT'){ship=mapShip.get(x.source_entity_id)||null;if(!ship)throw new Error(`Invalid disruption shipment source ${x.disruption_id}`);warehouse=get('SELECT destination_warehouse_id FROM shipments WHERE id=?',ship)?.destination_warehouse_id||null;}
    else if(x.source_entity_type==='SUPPLIER'){
      supplier=mapSup.get(x.source_entity_id)||null;if(!supplier)throw new Error(`Invalid disruption supplier source ${x.disruption_id}`);
      // Supplier disruption has no source shipment or warehouse FK in the workbook; retain its source ID without guessing a downstream shipment.
    } else if(x.source_entity_type==='INVENTORY'){
      const inv=mapInv.get(x.source_entity_id);if(!inv)throw new Error(`Invalid disruption inventory source ${x.disruption_id}`);const row=get('SELECT warehouse_id FROM inventories WHERE id=?',inv);warehouse=row?.warehouse_id||null;
    }
    const type=status(x.disruption_type,{SHIPMENT_DELAY:'Shipment Delay',SUPPLIER_DELAY:'Supplier Delay',INVENTORY_SHORTAGE:'Inventory Shortage'},'Other');
    insert(`INSERT OR IGNORE INTO disruptions(disruption_code,title,disruption_type,severity,status,shortage_category,shipment_id,warehouse_id,location,description,estimated_delay_hours,detected_at,data_origin,source_entity_type,source_entity_id)
      VALUES(?,?,?,?,?,'None',?,?,?,?,?,?, 'synthetic',?,?)`,x.disruption_id,`${type} · ${x.source_entity_id}`,type,severity(x.severity),disruptionStatus(x.status),ship,warehouse,warehouse?get('SELECT location FROM warehouses WHERE id=?',warehouse)?.location:null,x.description,0,isoDate(x.detected_at)||nowIso(),x.source_entity_type,x.source_entity_id);
    mapDis.set(x.disruption_id,get('SELECT id FROM disruptions WHERE disruption_code=?',x.disruption_id).id);
  }
  // Link risk source pairs; supplied risk scores are retained only as synthetic reference data.
  for (const x of E.order_risks) {
    const order=mapOrder.get(x.order_id), dis=mapDis.get(x.disruption_id);
    if(!order||!dis)throw new Error(`Invalid risk relationship ${x.risk_id}`);
    insert(`INSERT OR IGNORE INTO disruption_affected_orders(disruption_id,customer_order_id) VALUES(?,?)`,dis,order);
    insert(`INSERT OR IGNORE INTO source_order_risks(risk_code,order_id,disruption_id,source_risk_score,source_risk_level,source_explanation,assessed_at,data_origin)
      VALUES(?,?,?,?,?,?,?,'synthetic')`,x.risk_id,order,dis,num(x.risk_score),x.risk_level,x.explanation,isoDate(x.assessed_at));
  }
  // Source workbook actors are archived as reference data; they are not application users.
  for (const x of E.users) insert(`INSERT OR REPLACE INTO synthetic_reference_records(source_type,source_id,payload_json,archived_at) VALUES('user',?,?,?)`,x.user_id,JSON.stringify(x),nowIso());
  // Workbook recovery-plan rows are proposals, not records that passed the app's
  // maker-checker flow. Keep them as source references; never publish them as Drafts.
  for (const x of E.recovery_plans) insert(
    `INSERT OR REPLACE INTO synthetic_reference_records(source_type,source_id,payload_json,archived_at) VALUES('recovery_plan_template',?,?,?)`,
    x.plan_id,JSON.stringify(x),nowIso());
  // Historical workbook approvals are not valid decisions in this app's maker-checker workflow. Archive, do not import into live approvals.
  for (const x of E.approvals) insert(`INSERT OR REPLACE INTO synthetic_reference_records(source_type,source_id,payload_json,archived_at) VALUES('approval',?,?,?)`,x.approval_id,JSON.stringify(x),nowIso());
  // Imported carrier events are workbook examples, not provider callbacks received by this app.
  for (const x of E.webhook_events) insert(
    `INSERT OR REPLACE INTO synthetic_reference_records(source_type,source_id,payload_json,archived_at) VALUES('carrier_event',?,?,?)`,
    x.event_id,JSON.stringify(x),nowIso());
  for (const x of E.notifications) insert(`INSERT OR REPLACE INTO synthetic_reference_records(source_type,source_id,payload_json,archived_at) VALUES('notification',?,?,?)`,x.notification_id,JSON.stringify(x),nowIso());
  for (const x of E.audit_logs) insert(`INSERT OR REPLACE INTO synthetic_reference_records(source_type,source_id,payload_json,archived_at) VALUES('audit_event',?,?,?)`,x.audit_id,JSON.stringify(x),nowIso());
  // Shipment risk values are derived from linked source risk assessments. For shipments
  // without a linked assessment, use a transparent deterministic status/reliability baseline.
  insert(`UPDATE suppliers SET reliability_score=MIN(1,MAX(0,reliability_score/100.0)) WHERE reliability_score>1`);
  insert(`UPDATE shipments AS s SET risk_score=ROUND(MIN(99,MAX(5,COALESCE(
    (SELECT AVG(r.source_risk_score) FROM source_order_risks r
      JOIN disruption_affected_orders x ON x.customer_order_id=r.order_id
      JOIN disruptions d ON d.id=x.disruption_id WHERE d.shipment_id=s.id),
    (CASE s.status WHEN 'Delayed' THEN 66 WHEN 'In Transit' THEN 43 WHEN 'Scheduled' THEN 30 WHEN 'Delivered' THEN 15 ELSE 35 END)
      + (1-COALESCE((SELECT sp.reliability_score FROM suppliers sp WHERE sp.id=s.supplier_id),0.85))*28
      + CASE WHEN EXISTS(SELECT 1 FROM disruptions dx WHERE dx.shipment_id=s.id AND dx.severity IN ('Critical','High') AND dx.status IN ('Active','Investigating')) THEN 7 ELSE 0 END
  ))),1) WHERE s.data_origin='synthetic'`);
  insert('INSERT INTO dataset_imports(dataset_key,imported_at,source_label) VALUES(?,?,?)',IMPORT_KEY,nowIso(),DATA.dataset_version);
  db.exec('COMMIT');
  const counts={};
  for(const table of ['suppliers','warehouses','products','carriers','inventories','shipments','shipment_items','customer_orders','order_items','disruptions','source_order_risks','recovery_plans','recovery_actions','users','webhook_events','notifications','approvals','audit_logs']) counts[table]=Number(get(`SELECT COUNT(*) AS n FROM ${table}`).n);
  console.log('Expanded synthetic dataset imported successfully (all records marked synthetic).');
  console.log(JSON.stringify(counts,null,2));
} catch (error) {
  try { db.exec('ROLLBACK'); } catch {}
  console.error('Synthetic dataset import failed:', error.message);
  process.exitCode=1;
} finally {
  try { db.close(); } catch {}
}
