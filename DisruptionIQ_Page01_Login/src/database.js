'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DATABASE_PATH || path.join(ROOT, 'instance', 'disruptioniq.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

// Table and column names intentionally mirror the SQLAlchemy backend models.
db.exec(`
CREATE TABLE IF NOT EXISTS customers (
 id INTEGER PRIMARY KEY, customer_code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'HUB_INCHARGE', customer_id INTEGER REFERENCES customers(id), full_name TEXT,
 is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_login TEXT
);
CREATE TABLE IF NOT EXISTS carriers (carrier_code TEXT PRIMARY KEY, name TEXT NOT NULL, service_type TEXT, tracking_prefix TEXT, data_origin TEXT NOT NULL DEFAULT 'synthetic');
CREATE TABLE IF NOT EXISTS suppliers (
 id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, country TEXT, city TEXT,
 reliability_score REAL NOT NULL DEFAULT 1, lead_time_days INTEGER NOT NULL DEFAULT 7,
 expected_supply_date TEXT, contact_email TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
 region TEXT, risk_score REAL NOT NULL DEFAULT 0, exposure TEXT
);
CREATE TABLE IF NOT EXISTS warehouses (
 id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, location TEXT,
 capacity_sqm REAL NOT NULL DEFAULT 0, current_utilization REAL NOT NULL DEFAULT 0,
 is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventories (
 id INTEGER PRIMARY KEY, warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
 sku TEXT NOT NULL, item_name TEXT NOT NULL, category TEXT, quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
 reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK(reserved_quantity >= 0), reorder_point INTEGER NOT NULL DEFAULT 10,
 unit_cost REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE(warehouse_id, sku)
);
CREATE TABLE IF NOT EXISTS shipments (
 id INTEGER PRIMARY KEY, tracking_number TEXT NOT NULL UNIQUE, supplier_id INTEGER REFERENCES suppliers(id),
 origin_warehouse_id INTEGER REFERENCES warehouses(id), destination_warehouse_id INTEGER REFERENCES warehouses(id),
 carrier TEXT, transport_mode TEXT NOT NULL DEFAULT 'Ocean', status TEXT NOT NULL DEFAULT 'In Transit',
 origin_city TEXT, destination_city TEXT, estimated_departure TEXT, actual_departure TEXT,
 estimated_arrival TEXT, actual_arrival TEXT, created_at TEXT NOT NULL,
 ui_status TEXT, risk_score REAL NOT NULL DEFAULT 0, progress REAL NOT NULL DEFAULT 0,
 unit_count INTEGER NOT NULL DEFAULT 0, eta_label TEXT
);
CREATE TABLE IF NOT EXISTS shipment_items (
 id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
 sku TEXT NOT NULL, item_name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0)
);
CREATE TABLE IF NOT EXISTS customer_orders (
 id INTEGER PRIMARY KEY, order_number TEXT NOT NULL UNIQUE, customer_id INTEGER REFERENCES customers(id), customer_name TEXT NOT NULL,
 customer_tier TEXT NOT NULL DEFAULT 'Standard', status TEXT NOT NULL DEFAULT 'Pending',
 priority TEXT NOT NULL DEFAULT 'Medium', total_value REAL NOT NULL DEFAULT 0,
 assigned_warehouse_id INTEGER REFERENCES warehouses(id), order_date TEXT NOT NULL, delivery_deadline TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
 id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
 sku TEXT NOT NULL, item_name TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
 unit_price REAL NOT NULL DEFAULT 0 CHECK(unit_price >= 0)
);
CREATE TABLE IF NOT EXISTS disruptions (
 id INTEGER PRIMARY KEY, disruption_code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, disruption_type TEXT NOT NULL,
 severity TEXT NOT NULL DEFAULT 'Medium', status TEXT NOT NULL DEFAULT 'Active',
 shortage_category TEXT NOT NULL DEFAULT 'None', shipment_id INTEGER REFERENCES shipments(id),
 warehouse_id INTEGER REFERENCES warehouses(id), location TEXT, description TEXT,
 estimated_delay_hours INTEGER NOT NULL DEFAULT 0, detected_at TEXT NOT NULL, resolved_at TEXT,
 ui_route TEXT, ui_impact TEXT, ui_age TEXT, ui_owner TEXT
);
CREATE TABLE IF NOT EXISTS disruption_affected_orders (
 disruption_id INTEGER NOT NULL REFERENCES disruptions(id) ON DELETE CASCADE,
 customer_order_id INTEGER NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
 PRIMARY KEY(disruption_id, customer_order_id)
);
CREATE TABLE IF NOT EXISTS recovery_plans (
 id INTEGER PRIMARY KEY, plan_code TEXT NOT NULL UNIQUE, disruption_id INTEGER NOT NULL REFERENCES disruptions(id) ON DELETE CASCADE,
 customer_order_id INTEGER REFERENCES customer_orders(id), title TEXT NOT NULL, strategy_type TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'Draft', sku TEXT, quantity INTEGER NOT NULL DEFAULT 0,
 source_warehouse_id INTEGER REFERENCES warehouses(id), destination_warehouse_id INTEGER REFERENCES warehouses(id),
 source_location TEXT, destination_location TEXT, estimated_cost REAL NOT NULL DEFAULT 0, cost_estimate_verified INTEGER NOT NULL DEFAULT 0,
 estimated_delay_reduction_hours INTEGER NOT NULL DEFAULT 0, description TEXT, rationale TEXT,
 version INTEGER NOT NULL DEFAULT 1, approval_version INTEGER, created_by_id INTEGER REFERENCES users(id),
 executed_by_id INTEGER REFERENCES users(id), executed_at TEXT, execution_idempotency_key TEXT UNIQUE,
 execution_notes TEXT, execution_result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 protected_value REAL NOT NULL DEFAULT 0, priority TEXT NOT NULL DEFAULT 'Medium', progress REAL NOT NULL DEFAULT 0,
 due_label TEXT
);
CREATE TABLE IF NOT EXISTS recovery_actions (
 id INTEGER PRIMARY KEY, recovery_plan_id INTEGER NOT NULL REFERENCES recovery_plans(id) ON DELETE CASCADE,
 action_sequence INTEGER NOT NULL DEFAULT 1, action_type TEXT NOT NULL, description TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'Pending', cost REAL NOT NULL DEFAULT 0, assigned_to_role TEXT,
 executed_at TEXT, result_details TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
 id INTEGER PRIMARY KEY, recovery_plan_id INTEGER NOT NULL REFERENCES recovery_plans(id) ON DELETE CASCADE,
 requester_id INTEGER NOT NULL REFERENCES users(id), approver_id INTEGER REFERENCES users(id),
 required_role TEXT NOT NULL DEFAULT 'RECOVERY_MANAGER', status TEXT NOT NULL DEFAULT 'Pending',
 comments TEXT, requested_at TEXT NOT NULL, decision_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
 entity_type TEXT NOT NULL, entity_id TEXT, details TEXT, ip_address TEXT, timestamp TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
 id INTEGER PRIMARY KEY, event_identifier TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
 event_type TEXT NOT NULL, payload_json TEXT NOT NULL, processing_status TEXT NOT NULL DEFAULT 'Received',
 received_at TEXT NOT NULL, processed_at TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
 id INTEGER PRIMARY KEY, recipient_role TEXT, recipient_user_id INTEGER REFERENCES users(id),
 title TEXT NOT NULL, message TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Info',
 is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_movements (
 id INTEGER PRIMARY KEY, movement_code TEXT NOT NULL UNIQUE, recovery_plan_id INTEGER NOT NULL REFERENCES recovery_plans(id),
 sku TEXT NOT NULL, source_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id), destination_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
 quantity INTEGER NOT NULL CHECK(quantity > 0), movement_type TEXT NOT NULL, recorded_by_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
 data_origin TEXT NOT NULL DEFAULT 'simulated'
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_plan ON stock_movements(recovery_plan_id);
CREATE TABLE IF NOT EXISTS simulation_runs (
 id INTEGER PRIMARY KEY, simulation_code TEXT NOT NULL UNIQUE, created_by_id INTEGER NOT NULL REFERENCES users(id),
 scenario_type TEXT NOT NULL, title TEXT NOT NULL, parameters_json TEXT NOT NULL, result_json TEXT NOT NULL,
 created_at TEXT NOT NULL, data_origin TEXT NOT NULL DEFAULT 'simulated'
);
CREATE INDEX IF NOT EXISTS idx_simulation_created ON simulation_runs(created_at DESC);
CREATE TABLE IF NOT EXISTS sessions (
 id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_token TEXT NOT NULL,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);
CREATE INDEX IF NOT EXISTS idx_disruptions_status ON disruptions(status, severity);
CREATE INDEX IF NOT EXISTS idx_orders_warehouse_status ON customer_orders(assigned_warehouse_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_recovery_status ON recovery_plans(status);
`);

// Additive local SQLite compatibility for databases created by earlier DisruptionIQ builds.
function ensureColumn(table, column, definition){
  const columns=db.prepare(`PRAGMA table_info(${table})`).all();
  if(!columns.some(row=>row.name===column)){db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);return true;}
  return false;
}
ensureColumn('users','customer_id','INTEGER REFERENCES customers(id)');
ensureColumn('notifications','customer_order_id','INTEGER REFERENCES customer_orders(id)');
ensureColumn('notifications','recovery_plan_id','INTEGER REFERENCES recovery_plans(id)');
ensureColumn('webhook_events','error_details','TEXT');
ensureColumn('notifications','disruption_id','INTEGER REFERENCES disruptions(id)');
ensureColumn('notifications','data_origin',"TEXT NOT NULL DEFAULT 'operational'");
ensureColumn('customer_orders','customer_id','INTEGER REFERENCES customers(id)');
ensureColumn('suppliers','state','TEXT');
ensureColumn('warehouses','capacity_units','INTEGER NOT NULL DEFAULT 0');
ensureColumn('shipments','source_record_id','TEXT');
ensureColumn('shipments','carrier_code','TEXT');
ensureColumn('inventories','source_record_id','TEXT');
ensureColumn('order_items','unit_price_available','INTEGER NOT NULL DEFAULT 1');
ensureColumn('recovery_plans','estimated_recovery_days','REAL');
ensureColumn('recovery_plans','cost_estimate_verified','INTEGER NOT NULL DEFAULT 0');
ensureColumn('disruptions','source_entity_type','TEXT');
ensureColumn('disruptions','source_entity_id','TEXT');
const dataOriginMigrationNeeded = ['suppliers','warehouses','inventories','shipments','shipment_items','customer_orders','order_items','disruptions','recovery_plans','recovery_actions','approvals','audit_logs','webhook_events','notifications','users'].map(table=>ensureColumn(table,'data_origin',"TEXT NOT NULL DEFAULT 'operational'")).some(Boolean);
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_customer ON customer_orders(customer_id); CREATE INDEX IF NOT EXISTS idx_users_customer ON users(customer_id);');
// Normalize legacy role labels to the four supported demo roles.
db.prepare(`UPDATE users SET role='CUSTOMER' WHERE upper(role)='CUSTOMER'`).run();
db.prepare(`UPDATE users SET role='HUB_INCHARGE' WHERE role NOT IN ('CUSTOMER','RISK_ANALYST','RECOVERY_MANAGER')`).run();
db.prepare(`UPDATE approvals SET required_role='RECOVERY_MANAGER' WHERE required_role IS NULL OR required_role NOT IN ('RECOVERY_MANAGER')`).run();
db.prepare(`UPDATE recovery_actions SET assigned_to_role='HUB_INCHARGE' WHERE assigned_to_role IS NOT NULL AND assigned_to_role<>'HUB_INCHARGE'`).run();
db.prepare(`UPDATE notifications SET recipient_role='HUB_INCHARGE' WHERE recipient_role IN ('Operations Analyst','Supply Chain Manager','Warehouse Operator','Procurement Approver','Administrator','All')`).run();

function nowIso(){ return new Date().toISOString(); }
function get(sql, ...args){ return db.prepare(sql).get(...args); }
function all(sql, ...args){ return db.prepare(sql).all(...args); }
function run(sql, ...args){ return db.prepare(sql).run(...args); }
function audit({userId=null, action, entityType, entityId=null, details='', ip=null}) {
  run(`INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details,ip_address,timestamp,data_origin) VALUES(?,?,?,?,?,?,?,'operational')`, userId, action, entityType, entityId==null?null:String(entityId), details, ip, nowIso());
}

function ensureDevelopmentAccounts(){
  const production=process.env.NODE_ENV==='production';
  if(production)return null; // Demo credentials are never seeded into production.
  const {hashPassword}=require('./password');
  const now=nowIso();
  const customerEmail='customer@disruptioniq.local';
  // Exactly four development identities: one per requested application role.
  run(`INSERT OR IGNORE INTO customers(customer_code,name,email,phone,created_at) VALUES(?,?,?,?,?)`,'CUS-DEMO-001','Asterion Mobility',customerEmail,'+91-90000-10001',now);
  const customer=get('SELECT * FROM customers WHERE email=?',customerEmail);
  const accounts=[
    {username:'hub_incharge',email:'hub@disruptioniq.local',role:'HUB_INCHARGE',name:'DisruptionIQ Hub In-Charge',password:process.env.DEMO_HUB_PASSWORD||'Hub@DIQ2026!'},
    {username:'risk_analyst',email:'risk@disruptioniq.local',role:'RISK_ANALYST',name:'DisruptionIQ Risk Analyst',password:process.env.DEMO_RISK_PASSWORD||'Risk@DIQ2026!'},
    {username:'recovery_manager',email:'recovery@disruptioniq.local',role:'RECOVERY_MANAGER',name:'DisruptionIQ Recovery Manager',password:process.env.DEMO_RECOVERY_PASSWORD||'Recover@DIQ2026!'},
    {username:'demo_customer',email:customerEmail,role:'CUSTOMER',name:'Asterion Mobility Customer',password:process.env.DEMO_CUSTOMER_PASSWORD||'Customer@DIQ2026!',customer_id:customer.id}
  ];
  for(const account of accounts){
    const existing=get('SELECT id FROM users WHERE email=?',account.email);
    if(existing){
      run('UPDATE users SET username=?,role=?,full_name=?,is_active=1,customer_id=?,password_hash=? WHERE id=?',account.username,account.role,account.name,account.customer_id||null,hashPassword(account.password),existing.id);
    }else{
      run('INSERT INTO users(username,email,password_hash,role,customer_id,full_name,is_active,created_at) VALUES(?,?,?,?,?,?,1,?)',account.username,account.email,hashPassword(account.password),account.role,account.customer_id||null,account.name,now);
    }
  }
  run(`UPDATE users SET is_active=0 WHERE email IN ('admin@disruptioniq.local','analyst@disruptioniq.local','manager@disruptioniq.local','warehouse@disruptioniq.local','approver@disruptioniq.local','reviewer@disruptioniq.local','northstar@disruptioniq.local') OR email LIKE '%@dataset.disruptioniq.local'`);
  return {
    hub:get('SELECT * FROM users WHERE email=?','hub@disruptioniq.local'),
    risk:get('SELECT * FROM users WHERE email=?','risk@disruptioniq.local'),
    recovery:get('SELECT * FROM users WHERE email=?','recovery@disruptioniq.local'),
    customer:get('SELECT * FROM users WHERE email=?',customerEmail),
    customerRecord:customer
  };
}
function seedDatabase(){
  const demoAccounts=ensureDevelopmentAccounts();
  if(process.env.NODE_ENV==='production'&&get('SELECT COUNT(*) AS n FROM suppliers').n===0)throw new Error('Production database must be provisioned with operational data and a HUB_INCHARGE account. Development demo accounts are never seeded in production.');
  const userByRole = role => role==='CUSTOMER'?get('SELECT * FROM users WHERE role=? AND is_active=1','CUSTOMER'):get('SELECT * FROM users WHERE role=? AND is_active=1','HUB_INCHARGE');
  if (get('SELECT COUNT(*) AS n FROM suppliers').n > 0) {
    if(demoAccounts){
      const warehouse=get('SELECT id FROM warehouses ORDER BY id LIMIT 1');
      const attachDemoOrder=(customerName,orderNumber,customerId,total)=>{
        let order=get('SELECT * FROM customer_orders WHERE customer_name=? ORDER BY id LIMIT 1',customerName);
        if(!order){const id=run(`INSERT INTO customer_orders(order_number,customer_id,customer_name,customer_tier,status,priority,total_value,assigned_warehouse_id,order_date,delivery_deadline) VALUES(?,?,?,'Gold','Processing','High',?,?,?,?)`,orderNumber,customerId,customerName,total,warehouse?.id||null,nowIso(),new Date(Date.now()+7*86400000).toISOString()).lastInsertRowid;order=get('SELECT * FROM customer_orders WHERE id=?',Number(id));}
        else run('UPDATE customer_orders SET customer_id=? WHERE id=?',customerId,order.id);
      };
      attachDemoOrder('Asterion Mobility','ORD-DEMO-CUSTOMER-001',demoAccounts.customerRecord.id,12500);

    }
    return;
  }
  const sample = JSON.parse(fs.readFileSync(path.join(ROOT,'data','demo-data.json'),'utf8'));

  const supplierDefaults = [
    ['SUP-PACIFIC','Pacific Rim Silicon Ltd','Taiwan','Hsinchu',0.94,14,'APAC'],
    ['SUP-APEX','Apex Precision Foundry GmbH','Germany','Stuttgart',0.98,10,'Europe'],
    ['SUP-NORDIC','Nordic Sensor Systems AB','Sweden','Gothenburg',0.91,8,'Europe'],
    ['SUP-EUROTRANS','EuroTrans Enclosures BV','Netherlands','Rotterdam',0.97,5,'Europe'],
    ['SUP-SINGACHIP','SingaChip Microelectronics Pte','Singapore','Jurong',0.95,12,'APAC']
  ];
  const insertSupplier = db.prepare(`INSERT INTO suppliers(code,name,country,city,reliability_score,lead_time_days,expected_supply_date,contact_email,is_active,created_at,region,risk_score,exposure) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?)`);
  const suppliers = sample.suppliers || [];
  supplierDefaults.forEach((s,i)=>{
    const ui=suppliers[i]||{};
    insertSupplier.run(s[0],s[1],s[2],s[3],s[4],s[5],new Date(Date.now()+s[5]*86400000).toISOString(),`ops+${s[0].toLowerCase()}@disruptioniq.local`,nowIso(),s[6],Number(ui.risk||40),ui.exposure||'Operational capacity');
  });
  const supplierRows=all('SELECT * FROM suppliers');
  const supplierFor = (name, i=0) => supplierRows.find(s=>s.name.toLowerCase().includes(String(name||'').toLowerCase().split(' ')[0])) || supplierRows[i%supplierRows.length];

  const warehouseData = [
    ['WH-EAST','Rotterdam Eurohub Gateway','Rotterdam, Netherlands',45000,.76],
    ['WH-WEST','Long Beach Strategic Logistics Hub','Los Angeles, USA',60000,.88],
    ['WH-CENTRAL','Singapore Changi Global Fulfilment Hub','Singapore, Changi',55000,.62]
  ];
  const insertWh=db.prepare(`INSERT INTO warehouses(code,name,location,capacity_sqm,current_utilization,is_active,created_at) VALUES(?,?,?,?,?,1,?)`);
  warehouseData.forEach(x=>insertWh.run(...x,nowIso()));
  const whRows=all('SELECT * FROM warehouses');
  const warehouseForCity = city => {
    const c=String(city||'').toLowerCase();
    if(c.includes('rotterdam')||c.includes('frankfurt')) return whRows.find(x=>x.code==='WH-EAST');
    if(c.includes('chicago')||c.includes('los angeles')||c.includes('long beach')||c.includes('chennai')) return whRows.find(x=>x.code==='WH-WEST');
    return whRows.find(x=>x.code==='WH-CENTRAL');
  };

  const skuCatalog = [
    ['SKU-MCU-01','Cortex-M4 Industrial Microcontroller','Microcontrollers',28.5],
    ['SKU-MCU-02','Dual-Core DSP Signal Processor','Microcontrollers',45],
    ['SKU-SNS-01','6-Axis Inertial IMU Sensor','Sensors',16.8],
    ['SKU-SNS-02','Environmental Optical & Temp Sensor','Sensors',22.4],
    ['SKU-ACT-01','High-Torque Brushless Servo Actuator','Actuators',115],
    ['SKU-ACT-02','Precision Stepper Motor Driver','Actuators',34],
    ['SKU-PWR-01','48V/10A Industrial Power Module','Power Systems',68],
    ['SKU-BAT-01','24V 50Ah LiFePO4 Battery Unit','Power Systems',320],
    ['SKU-ENC-01','IP67 Sealed Aluminum Enclosure','Structural',54],
    ['SKU-HAR-01','Mil-Spec Braided Wiring Harness','Cabling',19.5]
  ];
  const inventorySpec={
    'WH-EAST':[[280,40,50],[150,20,30],[420,60,60],[20,15,30],[90,15,20],[130,25,30],[200,30,40],[80,10,15],[310,45,50],[450,50,70]],
    'WH-WEST':[[40,30,50],[210,30,40],[180,25,35],[190,30,40],[140,20,25],[110,15,25],[160,20,30],[95,12,20],[240,35,45],[320,40,50]],
    'WH-CENTRAL':[[350,45,60],[320,50,50],[280,35,40],[350,50,40],[110,15,20],[175,25,30],[240,35,40],[130,18,25],[190,20,30],[510,60,80]]
  };
  const insertInv=db.prepare(`INSERT INTO inventories(warehouse_id,sku,item_name,category,quantity,reserved_quantity,reorder_point,unit_cost,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  for(const wh of whRows) skuCatalog.forEach((sku,i)=>{const spec=inventorySpec[wh.code][i];insertInv.run(wh.id,sku[0],sku[1],sku[2],...spec,sku[3],nowIso());});

  const insertShipment=db.prepare(`INSERT INTO shipments(tracking_number,supplier_id,origin_warehouse_id,destination_warehouse_id,carrier,transport_mode,status,origin_city,destination_city,estimated_departure,actual_departure,estimated_arrival,actual_arrival,created_at,ui_status,risk_score,progress,unit_count,eta_label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertShipmentItem=db.prepare(`INSERT INTO shipment_items(shipment_id,sku,item_name,quantity) VALUES(?,?,?,?)`);
  const skuAt=i=>skuCatalog[i%skuCatalog.length];
  for(let i=0;i<sample.shipments.length;i++){
    const s=sample.shipments[i];const parts=s.route.split('→').map(x=>x.trim());const origin=parts[0]||'Unknown';const dest=parts[1]||'Unknown';
    const supplier=supplierFor(origin,i);const ow=warehouseForCity(origin);const dw=warehouseForCity(dest);
    const status=s.status==='Delayed'?'Delayed':'In Transit';
    const etaDate=new Date(Date.UTC(2026,10,1+(i%5),8+(i%8),30));
    const dep=new Date(Date.now()-(i+1)*3600000).toISOString();
    const id=Number(insertShipment.run(s.id,supplier.id,ow.id,dw.id,s.carrier,'Ocean',status,origin,dest,dep,dep,etaDate.toISOString(),null,nowIso(),s.status,s.risk,s.progress,s.units,s.eta).lastInsertRowid);
    const sku=skuAt(i);insertShipmentItem.run(id,sku[0],sku[1],s.units);
  }

  // A small relational order book is seeded so the deterministic risk engine has real order/inventory joins.
  const insertOrder=db.prepare(`INSERT INTO customer_orders(order_number,customer_name,customer_tier,status,priority,total_value,assigned_warehouse_id,order_date,delivery_deadline) VALUES(?,?,?,?,?,?,?,?,?)`);
  const insertOrderItem=db.prepare(`INSERT INTO order_items(order_id,sku,item_name,quantity,unit_price) VALUES(?,?,?,?,?)`);
  const tiers=['Platinum','Gold','Standard','Silver'];const priorities=['Critical','High','Medium','Low'];
  const orders=[];
  for(let i=0;i<12;i++){
    const ship=all('SELECT * FROM shipments ORDER BY id LIMIT 1 OFFSET ?',i)[0];
    const item=all('SELECT * FROM shipment_items WHERE shipment_id=? LIMIT 1',ship.id)[0];
    const deadline=new Date(Date.now()+((i%4===0)?18:(i%4===1?42:(i%4===2?96:168)))*3600000).toISOString();
    const orderId=Number(insertOrder.run(`ORD-2026-${String(1001+i)}`,['Asterion Mobility','Northstar Robotics','Helix Industrial','Meridian Automation'][i%4],tiers[i%4],i%3===0?'At Risk':'Pending',priorities[i%4],(i+1)*12500,ship.destination_warehouse_id,new Date(Date.now()-i*86400000).toISOString(),deadline).lastInsertRowid);
    insertOrderItem.run(orderId,item.sku,item.item_name,[120,80,55,35][i%4],item.quantity?Number((item.quantity/Math.max(1,[120,80,55,35][i%4])).toFixed(2)):28.5);
    orders.push({id:orderId,sku:item.sku,warehouse_id:ship.destination_warehouse_id});
  }
  if(demoAccounts){
    const demoOrder=get('SELECT id FROM customer_orders WHERE customer_name=? ORDER BY id LIMIT 1','Asterion Mobility');
    if(demoOrder)run('UPDATE customer_orders SET customer_id=? WHERE id=?',demoAccounts.customerRecord.id,demoOrder.id);
    // Other imported customers remain unlinked to demo logins and cannot be accessed through the customer portal.
  }

  const insertDis=db.prepare(`INSERT INTO disruptions(disruption_code,title,disruption_type,severity,status,shortage_category,shipment_id,warehouse_id,location,description,estimated_delay_hours,detected_at,resolved_at,ui_route,ui_impact,ui_age,ui_owner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const incidents=sample.incidents||[];
  const disRows=[];
  for(let i=0;i<incidents.length;i++){
    const x=incidents[i];
    const ship=all('SELECT s.* FROM shipments s WHERE s.ui_status=? ORDER BY s.risk_score DESC LIMIT 1','Delayed')[0] || all('SELECT * FROM shipments ORDER BY id LIMIT 1 OFFSET ?',i)[0];
    const dest=warehouseForCity((x.route.split('→')[1]||x.route).trim());
    const id=Number(insertDis.run(x.id,x.title,x.title.toLowerCase().includes('weather')?'Severe Weather':x.title.toLowerCase().includes('supplier')?'Supplier Shortage':x.title.toLowerCase().includes('port')?'Port Congestion':'Carrier Delay',x.severity,x.status==='Acknowledged'?'Resolved':x.status==='Investigating'?'Investigating':'Active','Potential Shortage',ship?.id||null,dest?.id||null,x.route.split('→')[1]?.trim()||x.route,x.impact,([36,24,10,48,6][i]),new Date(Date.now()-(i+1)*60000).toISOString(),x.status==='Acknowledged'?nowIso():null,x.route,x.impact,x.age,x.owner).lastInsertRowid);
    disRows.push({id,record:x});
  }
  const link=db.prepare('INSERT OR IGNORE INTO disruption_affected_orders(disruption_id,customer_order_id) VALUES(?,?)');
  for(const d of disRows){
    const dRec=get('SELECT * FROM disruptions WHERE id=?',d.id);
    const linked=orders.filter(o=>o.warehouse_id===dRec.warehouse_id).slice(0,3);
    for(const order of linked) link.run(d.id,order.id);
  }

  const insertPlan=db.prepare(`INSERT INTO recovery_plans(plan_code,disruption_id,title,strategy_type,status,quantity,estimated_cost,estimated_delay_reduction_hours,description,rationale,version,created_by_id,created_at,updated_at,protected_value,priority,progress,due_label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const plans=sample.recoveryPlans||[];const manager=userByRole('HUB_INCHARGE');
  for(let i=0;i<plans.length;i++){
    const p=plans[i];const d=disRows[i%disRows.length];
    const pid=Number(insertPlan.run(p.id,d.id,p.title,p.title.toLowerCase().includes('supplier')?'Alternative Supplier':p.title.toLowerCase().includes('reroute')?'Expedited Freight':'Inter-Warehouse Stock Transfer','Draft',1200,Math.max(0,p.value*.025),24,`Sample mitigation plan: ${p.title}`,`Seeded template for ${d.record.id}; revalidate before submission.`,1,null,nowIso(),nowIso(),p.value,p.priority,p.progress,p.due).lastInsertRowid);
    db.prepare(`INSERT INTO recovery_actions(recovery_plan_id,action_sequence,action_type,description,status,cost,assigned_to_role) VALUES(?,?,?,?,?,?,?)`).run(pid,1,'SIMULATED_MITIGATION',p.title,p.progress>=100?'Completed':'Pending',Math.max(0,p.value*.025),'HUB_INCHARGE');
  }
  // Sample plans remain Draft templates. Approval rows, decisions, notifications and audit events are created only by authenticated user actions.
}

module.exports = { db, DB_PATH, get, all, run, audit, nowIso };
if (process.env.DIQ_SKIP_SEED !== '1') {
  seedDatabase();
  // Existing local demo rows predate provenance tagging. Mark them synthetic once during migration.
  if(dataOriginMigrationNeeded && process.env.NODE_ENV!=='production'){
    for(const table of ['suppliers','warehouses','inventories','shipments','shipment_items','customer_orders','order_items','disruptions','recovery_plans','recovery_actions','approvals','audit_logs','webhook_events','notifications','users'])run(`UPDATE ${table} SET data_origin='synthetic' WHERE data_origin='operational'`);
  }
}
