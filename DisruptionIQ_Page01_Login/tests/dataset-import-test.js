 'use strict';
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'diq-expanded-dataset-'));
const dbPath=path.join(temp,'dataset.db');
const env={...process.env,DATABASE_PATH:dbPath,NODE_ENV:'test'};
function run(args){
 const r=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',...args],{cwd:root,env,encoding:'utf8',timeout:180000});
 if(r.status!==0)throw new Error(`${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
 return r.stdout;
}
try{
 const first=run(['scripts/import-expanded-dataset.js']);
 assert.match(first,/imported successfully/);
 const second=run(['scripts/import-expanded-dataset.js']);
 assert.match(second,/already imported/);
 const normalized=run(['scripts/normalize-demo-governance.js']);
 assert.match(normalized,/archived_recovery_plan_templates/);
 const db=new DatabaseSync(dbPath);
 try{
  const count=sql=>Number(db.prepare(sql).get().n);
  const expected=[
   ["suppliers", "SELECT COUNT(*) n FROM suppliers WHERE code GLOB 'SUP[0-9]*'"],
   ["warehouses", "SELECT COUNT(*) n FROM warehouses WHERE code GLOB 'WH[0-9]*'"],
   ["products", "SELECT COUNT(*) n FROM products WHERE data_origin='synthetic'"],
   ["carriers", "SELECT COUNT(*) n FROM carriers WHERE data_origin='synthetic'"],
   ["inventory", "SELECT COUNT(*) n FROM inventories i JOIN warehouses w ON w.id=i.warehouse_id WHERE w.code GLOB 'WH[0-9]*' AND i.data_origin='synthetic'"],
   ["shipments", "SELECT COUNT(*) n FROM shipments WHERE tracking_number LIKE 'TRK-0000%' AND data_origin='synthetic'"],
   ["shipment_items", "SELECT COUNT(*) n FROM shipment_items i JOIN shipments s ON s.id=i.shipment_id WHERE s.tracking_number LIKE 'TRK-0000%' AND i.data_origin='synthetic'"],
   ["orders", "SELECT COUNT(*) n FROM customer_orders WHERE order_number GLOB 'ORD[0-9]*' AND data_origin='synthetic'"],
   ["order_items", "SELECT COUNT(*) n FROM order_items i JOIN customer_orders o ON o.id=i.order_id WHERE o.order_number GLOB 'ORD[0-9]*' AND i.data_origin='synthetic'"],
   ["order_item_prices", "SELECT COUNT(*) n FROM order_items i JOIN customer_orders o ON o.id=i.order_id WHERE o.order_number GLOB 'ORD[0-9]*' AND i.unit_price_available=0"],
   ["disruptions", "SELECT COUNT(*) n FROM disruptions WHERE disruption_code GLOB 'DIS[0-9]*' AND data_origin='synthetic'"],
   ["order_risks", "SELECT COUNT(*) n FROM source_order_risks WHERE data_origin='synthetic'"],
   ["recovery_plan_templates", "SELECT COUNT(*) n FROM synthetic_reference_records WHERE source_type='recovery_plan_template'"],
   ["source_users", "SELECT COUNT(*) n FROM synthetic_reference_records WHERE source_type='user'"],
   ["source_carrier_events", "SELECT COUNT(*) n FROM synthetic_reference_records WHERE source_type='carrier_event'"],
   ["source_notifications", "SELECT COUNT(*) n FROM synthetic_reference_records WHERE source_type='notification'"],
   ["source_approvals", "SELECT COUNT(*) n FROM synthetic_reference_records WHERE source_type='approval'"],
   ["source_audit_events", "SELECT COUNT(*) n FROM synthetic_reference_records WHERE source_type='audit_event'"]
  ];
  for(const [name,sql] of expected){const expectedCount=['source_users','source_carrier_events','source_notifications','source_approvals','source_audit_events'].includes(name)?350: name==='recovery_plan_templates'?350:350;assert.equal(count(sql),expectedCount,`${name} must import or archive all 350 source records`);}
  assert.equal(count("SELECT COUNT(*) n FROM recovery_plans WHERE data_origin='synthetic'"),0,'Workbook recovery plans are not live/actionable plans');assert.equal(count("SELECT COUNT(*) n FROM approvals WHERE data_origin='synthetic'"),0,'Workbook approvals are not live decisions');assert.equal(count("SELECT COUNT(*) n FROM audit_logs WHERE data_origin='synthetic'"),0,'Workbook audit samples are not live application events');assert.equal(count("SELECT COUNT(*) n FROM users WHERE email LIKE '%@dataset.disruptioniq.local'"),0,'Workbook actors are reference records, not login identities');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0,'All SQLite foreign keys must validate');
  assert.equal(count("SELECT COUNT(*) n FROM recovery_actions a JOIN recovery_plans p ON p.id=a.recovery_plan_id WHERE p.plan_code GLOB 'RPL[0-9]*'"),0,'Do not fabricate recovery actions when the workbook has no recovery-actions sheet');
  assert.equal(count("SELECT COUNT(*) n FROM disruptions WHERE data_origin='synthetic' AND source_entity_type='SUPPLIER' AND shipment_id IS NULL AND warehouse_id IS NULL"),100,'Supplier disruption records must not be attached to guessed shipments or hubs');
  assert.equal(count("SELECT COUNT(*) n FROM shipments s LEFT JOIN carriers c ON c.carrier_code=s.carrier_code WHERE s.source_record_id IS NOT NULL AND (c.carrier_code IS NULL OR s.carrier_code IS NULL)"),0,'Every imported shipment carrier must resolve');
  assert.equal(count("SELECT COUNT(*) n FROM disruptions d LEFT JOIN shipments s ON s.source_record_id=d.source_entity_id WHERE d.source_entity_type='SHIPMENT' AND s.id IS NULL"),0,'Shipment source IDs must remain available');
  assert.equal(count("SELECT COUNT(*) n FROM disruptions d LEFT JOIN suppliers s ON s.code=d.source_entity_id WHERE d.source_entity_type='SUPPLIER' AND s.id IS NULL"),0,'Supplier disruption source IDs must resolve');
  assert.equal(count("SELECT COUNT(*) n FROM disruptions d LEFT JOIN inventories i ON i.source_record_id=d.source_entity_id WHERE d.source_entity_type='INVENTORY' AND i.id IS NULL"),0,'Inventory disruption source IDs must resolve');
  assert.equal(count("SELECT COUNT(*) n FROM approvals WHERE data_origin='synthetic'"),0,'No imported approval rows may appear as current workflow decisions');
  const activeSourceUsers=count("SELECT COUNT(*) n FROM users WHERE is_active=1 AND email LIKE '%@dataset.disruptioniq.local'");assert.equal(activeSourceUsers,0,'Source workbook users must never be active login accounts');
 }finally{db.close();}
 const code="const d=require('./src/services/data-service').buildDashboardSections(); console.log(JSON.stringify({summary:d.summary,health:d.shipment_health,env:d.environment}));";
 const dashboard=JSON.parse(run(['-e',code]).trim());
 assert.equal(dashboard.env,'DisruptionIQ operational workspace');
 assert.ok(dashboard.summary.total_shipments>=350);
 assert.ok(dashboard.summary.active_disruptions>0);
 assert.equal(dashboard.health.values.reduce((a,b)=>a+b,0),dashboard.health.total);
 const hubCode=`const h=require('./src/services/hub-service');const o=h.getHubOverview();const l=h.listHubs({page:1,limit:100});const d=require('./src/database');const n=q=>Number(d.get(q).n||0);console.log(JSON.stringify({overview:o,list:l,expected:{warehouses:n('SELECT COUNT(*) n FROM warehouses'),active:n('SELECT COUNT(*) n FROM warehouses WHERE is_active=1'),shipments:n('SELECT COUNT(*) n FROM shipments WHERE origin_warehouse_id IS NOT NULL OR destination_warehouse_id IS NOT NULL'),delayed:n(\"SELECT COUNT(*) n FROM shipments WHERE status=\'Delayed\' AND (origin_warehouse_id IS NOT NULL OR destination_warehouse_id IS NOT NULL)\"),disruptions:n(\"SELECT COUNT(DISTINCT d.id) n FROM disruptions d WHERE d.status IN (\'Active\',\'Investigating\') AND (d.warehouse_id IS NOT NULL OR EXISTS(SELECT 1 FROM shipments s WHERE s.id=d.shipment_id AND (s.origin_warehouse_id IS NOT NULL OR s.destination_warehouse_id IS NOT NULL)) OR EXISTS(SELECT 1 FROM inventories i WHERE upper(COALESCE(d.source_entity_type,\'\'))=\'INVENTORY\' AND i.source_record_id=d.source_entity_id))\")}}));`;
 const hubCheck=JSON.parse(run(['-e',hubCode]).trim());
 assert.equal(hubCheck.overview.summary.total_hubs,hubCheck.expected.warehouses);
 assert.equal(hubCheck.overview.summary.active_hubs,hubCheck.expected.active);
 assert.equal(hubCheck.overview.summary.total_shipments,hubCheck.expected.shipments);
 assert.equal(hubCheck.overview.summary.delayed_shipments,hubCheck.expected.delayed);
 assert.equal(hubCheck.overview.summary.active_disruptions,hubCheck.expected.disruptions);
 assert.equal(hubCheck.list.total,hubCheck.expected.warehouses);
 for(const hub of hubCheck.list.hubs.slice(0,10)){
  const direct=JSON.parse(run(['-e',`const h=require('./src/services/hub-service');const d=require('./src/database');const id=${hub.id};const row=h.getHubById(id);console.log(JSON.stringify({shipments:d.get('SELECT COUNT(DISTINCT id) n FROM shipments WHERE origin_warehouse_id=? OR destination_warehouse_id=?',id,id).n,inventory:d.get('SELECT COUNT(*) n FROM inventories WHERE warehouse_id=?',id).n,detail:{shipments:row.shipments.length,inventory:row.inventory_records.length}}));`]).trim());
  assert.equal(hub.shipment.total,direct.shipments);
  assert.equal(hub.inventory.tracked_items,direct.inventory);
  assert.equal(direct.detail.shipments,direct.shipments);
  assert.equal(direct.detail.inventory,Math.min(100,direct.inventory));
 }
 const inventoryCode=`const s=require('./src/services/inventory-service');const d=require('./src/database');const n=(q,...a)=>Number(d.get(q,...a).n||0);const o=s.inventoryOverview();const l=s.warehouseList({page:1,limit:100});const w=d.get("SELECT * FROM warehouses WHERE code GLOB 'WH[0-9]*' ORDER BY id LIMIT 1");const detail=s.warehouseDetail(w.id);const inv=s.warehouseCollection(w.id,'inventory',{page:1,limit:100});const ships=s.warehouseCollection(w.id,'shipments',{page:1,limit:100});const product=d.get('SELECT sku FROM products ORDER BY sku LIMIT 1');const productInventory=s.productInventory(product.sku);console.log(JSON.stringify({overview:o,list:l,detail,inventory:inv,shipments:ships,productInventory,expected:{warehouses:n('SELECT COUNT(*) n FROM warehouses'),active:n('SELECT COUNT(*) n FROM warehouses WHERE is_active=1'),records:n('SELECT COUNT(*) n FROM inventories'),products:n('SELECT COUNT(DISTINCT sku) n FROM inventories'),available:n('SELECT SUM(MAX(0,quantity-reserved_quantity)) n FROM inventories'),low:n('SELECT COUNT(*) n FROM inventories WHERE MAX(0,quantity-reserved_quantity)>0 AND MAX(0,quantity-reserved_quantity)<=reorder_point'),out:n('SELECT COUNT(*) n FROM inventories WHERE MAX(0,quantity-reserved_quantity)=0'),synthetic:n('SELECT COUNT(*) n FROM inventories WHERE data_origin=? AND source_record_id IS NOT NULL','synthetic')}}));`;
 const inventoryCheck=JSON.parse(run(['-e',inventoryCode]).trim());
 assert.equal(inventoryCheck.overview.summary.total_warehouses,inventoryCheck.expected.warehouses);
 assert.equal(inventoryCheck.overview.summary.active_warehouses,inventoryCheck.expected.active);
 assert.equal(inventoryCheck.overview.summary.inventory_records,inventoryCheck.expected.records);
 assert.equal(inventoryCheck.overview.summary.tracked_products,inventoryCheck.expected.products);
 assert.equal(inventoryCheck.overview.summary.available_units,inventoryCheck.expected.available);
 assert.equal(inventoryCheck.overview.summary.low_stock_records,inventoryCheck.expected.low);
 assert.equal(inventoryCheck.overview.summary.out_of_stock_records,inventoryCheck.expected.out);
 assert.equal(inventoryCheck.list.total,inventoryCheck.expected.warehouses);
 assert.ok(inventoryCheck.inventory.items.every(x=>['In Stock','Low Stock','Out of Stock'].includes(x.stock_status)));
 assert.equal(inventoryCheck.expected.synthetic,350);
 assert.equal(new Set(inventoryCheck.shipments.items.map(x=>x.id)).size,inventoryCheck.shipments.items.length);
 assert.ok(inventoryCheck.detail.summary.inventory_records>=1);
 assert.ok(inventoryCheck.productInventory.product);
 assert.ok(inventoryCheck.productInventory.items.length>=1);
 assert.ok(inventoryCheck.productInventory.items.every(x=>x.warehouse_id&&x.data_origin==='synthetic'));
 const supplierCode=`const s=require('./src/services/supplier-service');const d=require('./src/database');const n=q=>Number(d.get(q).n||0);const overview=s.supplierOverview();const list=s.supplierList({page:1,limit:100});const supplier=d.get("SELECT * FROM suppliers WHERE code GLOB 'SUP[0-9]*' ORDER BY id LIMIT 1");const detail=s.supplierDetail(supplier.id);const products=s.supplierCollection(supplier.id,'products',{page:1,limit:100});const disruptions=s.supplierCollection(supplier.id,'disruptions',{page:1,limit:100});console.log(JSON.stringify({overview,listTotal:list.total,uniqueIds:new Set(list.suppliers.map(x=>x.id)).size,expected:{total:n('SELECT COUNT(*) n FROM suppliers'),active:n('SELECT COUNT(*) n FROM suppliers WHERE is_active=1'),withShipments:n('SELECT COUNT(DISTINCT supplier_id) n FROM shipments WHERE supplier_id IS NOT NULL'),supplierEvents:n("SELECT COUNT(*) n FROM disruptions WHERE source_entity_type='SUPPLIER' AND shipment_id IS NULL")},supplier,detail,products,disruptions}));`;
 const supplierCheck=JSON.parse(run(['-e',supplierCode]).trim());
 assert.equal(supplierCheck.overview.summary.total,supplierCheck.expected.total);
 assert.equal(supplierCheck.overview.summary.active,supplierCheck.expected.active);
 assert.equal(supplierCheck.overview.summary.with_shipments,supplierCheck.expected.withShipments);
 assert.equal(supplierCheck.overview.summary.with_disruptions>=1,true);
 assert.equal(supplierCheck.listTotal,supplierCheck.expected.total);
 assert.equal(supplierCheck.uniqueIds,100);
 assert.ok(supplierCheck.detail.relationship_notes.products.includes('Indirect association'));
 assert.ok(supplierCheck.products.products.every(x=>x.data_origin==='synthetic'));
 assert.ok(supplierCheck.disruptions.disruptions.every(x=>x.source_entity_type==='SUPPLIER'||x.shipment_id!==null));
 assert.equal(supplierCheck.expected.supplierEvents,100,'Supplier-only source disruptions remain unassigned to shipments');
 console.log('PASS operational source data imported and idempotent; historical users, approvals, audit rows and plan templates archived as reference records');
 console.log('PASS imported dataset produces DB-backed Page 04, Page 05, Page 08 and Page 09 warehouse/inventory metrics');
 console.log('PASS Page 09 inventory classification, warehouse register, product-to-warehouse lookup, shipment de-duplication and 350 synthetic inventory source records');
 console.log('PASS imported supplier register, product associations and supplier-source disruption records preserve synthetic provenance');
}finally{try{fs.rmSync(temp,{recursive:true,force:true});}catch{}}
