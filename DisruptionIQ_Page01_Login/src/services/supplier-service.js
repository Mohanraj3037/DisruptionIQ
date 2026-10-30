'use strict';
const {all,get}=require('../database');
const ACTIVE="('Active','Investigating')";
const n=v=>Number(v||0);
const hasTable=name=>!!get("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?",name);
const productTable=()=>hasTable('products');
const productJoin=()=>productTable()?`LEFT JOIN products p ON p.sku=si.sku`:'';
const productName=()=>productTable()?`COALESCE(p.name,si.item_name)`:'si.item_name';
const supplierShipmentWhere='s.supplier_id=?';
function supplierOverview(){
 const row=get(`SELECT COUNT(*) total,
  SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) active,
  SUM(CASE WHEN is_active=0 THEN 1 ELSE 0 END) inactive,
  SUM(CASE WHEN EXISTS(SELECT 1 FROM shipments s WHERE s.supplier_id=suppliers.id) THEN 1 ELSE 0 END) with_shipments,
  SUM(CASE WHEN EXISTS(SELECT 1 FROM disruptions d WHERE d.source_entity_type='SUPPLIER' AND d.source_entity_id=suppliers.code) OR EXISTS(SELECT 1 FROM disruptions d JOIN shipments s ON s.id=d.shipment_id WHERE s.supplier_id=suppliers.id) THEN 1 ELSE 0 END) with_disruptions,
  SUM(CASE WHEN EXISTS(SELECT 1 FROM disruptions d JOIN shipments s ON s.id=d.shipment_id WHERE s.supplier_id=suppliers.id AND d.status IN ${ACTIVE}) THEN 1 ELSE 0 END) with_affected_shipments,
  SUM(CASE WHEN EXISTS(SELECT 1 FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id LEFT JOIN shipments s ON s.id=d.shipment_id WHERE (s.supplier_id=suppliers.id OR (d.source_entity_type='SUPPLIER' AND d.source_entity_id=suppliers.code))) THEN 1 ELSE 0 END) with_recovery,
  SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM shipments s WHERE s.supplier_id=suppliers.id) AND NOT EXISTS(SELECT 1 FROM disruptions d WHERE d.source_entity_type='SUPPLIER' AND d.source_entity_id=suppliers.code) THEN 1 ELSE 0 END) no_operational_activity
  FROM suppliers`);
 const products=productTable()?n(get(`SELECT COUNT(DISTINCT p.sku) n FROM products p JOIN shipment_items si ON si.sku=p.sku JOIN shipments s ON s.id=si.shipment_id WHERE s.supplier_id IS NOT NULL`).n):n(get(`SELECT COUNT(DISTINCT si.sku) n FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id WHERE s.supplier_id IS NOT NULL`).n);
 const shipmentStatus=all(`SELECT s.status,COUNT(*) count FROM shipments s WHERE s.supplier_id IS NOT NULL GROUP BY s.status ORDER BY s.status`);
 const disruptionStatus=all(`SELECT d.status,COUNT(DISTINCT d.id) count FROM disruptions d LEFT JOIN shipments s ON s.id=d.shipment_id WHERE (s.supplier_id IS NOT NULL) OR (d.source_entity_type='SUPPLIER' AND EXISTS(SELECT 1 FROM suppliers sp WHERE sp.code=d.source_entity_id)) GROUP BY d.status ORDER BY d.status`);
 return {success:true,summary:{total:n(row.total),active:n(row.active),inactive:n(row.inactive),with_shipments:n(row.with_shipments),with_disruptions:n(row.with_disruptions),with_affected_shipments:n(row.with_affected_shipments),with_recovery:n(row.with_recovery),supplied_products:products,no_operational_activity:n(row.no_operational_activity)},shipment_status:shipmentStatus,disruption_status:disruptionStatus,last_updated:new Date().toISOString(),data_origin_note:'Source provenance is retained on supplier and related records.'};
}
function supplierList(params={}){
 const page=params.page||1,limit=params.limit||25,offset=(page-1)*limit,where=[],args=[];
 if(params.q){where.push('(CAST(sup.id AS TEXT) LIKE ? OR sup.code LIKE ? OR sup.name LIKE ?)');args.push(`%${params.q}%`,`%${params.q}%`,`%${params.q}%`);}
 if(params.status==='active')where.push('sup.is_active=1');if(params.status==='inactive')where.push('sup.is_active=0');
 if(params.products==='yes')where.push('EXISTS(SELECT 1 FROM shipments sx JOIN shipment_items six ON six.shipment_id=sx.id WHERE sx.supplier_id=sup.id)');
 if(params.products==='no')where.push('NOT EXISTS(SELECT 1 FROM shipments sx JOIN shipment_items six ON six.shipment_id=sx.id WHERE sx.supplier_id=sup.id)');
 if(params.disruption==='yes')where.push(`(EXISTS(SELECT 1 FROM disruptions dx WHERE dx.source_entity_type='SUPPLIER' AND dx.source_entity_id=sup.code) OR EXISTS(SELECT 1 FROM disruptions dx JOIN shipments sx ON sx.id=dx.shipment_id WHERE sx.supplier_id=sup.id))`);
 if(params.disruption==='no')where.push(`NOT EXISTS(SELECT 1 FROM disruptions dx WHERE dx.source_entity_type='SUPPLIER' AND dx.source_entity_id=sup.code) AND NOT EXISTS(SELECT 1 FROM disruptions dx JOIN shipments sx ON sx.id=dx.shipment_id WHERE sx.supplier_id=sup.id)`);
 if(params.activity==='yes')where.push(`(EXISTS(SELECT 1 FROM shipments sx WHERE sx.supplier_id=sup.id) OR EXISTS(SELECT 1 FROM disruptions dx WHERE dx.source_entity_type='SUPPLIER' AND dx.source_entity_id=sup.code))`);
 if(params.activity==='no')where.push(`NOT EXISTS(SELECT 1 FROM shipments sx WHERE sx.supplier_id=sup.id) AND NOT EXISTS(SELECT 1 FROM disruptions dx WHERE dx.source_entity_type='SUPPLIER' AND dx.source_entity_id=sup.code)`);
 const clause=where.length?`WHERE ${where.join(' AND ')}`:'';
 const sortMap={id:'sup.id',name:'sup.name',code:'sup.code',shipments:'shipment_count',products:'product_count',status:'sup.is_active'};
 const sort=sortMap[params.sort]||'sup.name',direction=params.direction==='desc'?'DESC':'ASC';
 const total=n(get(`SELECT COUNT(*) n FROM suppliers sup ${clause}`,...args)?.n);
 const rows=all(`SELECT sup.id,sup.code,sup.name,sup.country,sup.city,sup.state,sup.region,sup.contact_email,sup.is_active,sup.created_at,sup.data_origin,
  (SELECT COUNT(*) FROM shipments s WHERE s.supplier_id=sup.id) shipment_count,
  (SELECT COUNT(DISTINCT si.sku) FROM shipments s JOIN shipment_items si ON si.shipment_id=s.id WHERE s.supplier_id=sup.id) product_count,
  ((SELECT COUNT(DISTINCT d.id) FROM disruptions d WHERE d.source_entity_type='SUPPLIER' AND d.source_entity_id=sup.code)+(SELECT COUNT(DISTINCT d.id) FROM disruptions d JOIN shipments s ON s.id=d.shipment_id WHERE s.supplier_id=sup.id)) disruption_count
  FROM suppliers sup ${clause} ORDER BY ${sort} ${direction},sup.id ASC LIMIT ? OFFSET ?`,...args,limit,offset);
 return {success:true,page,limit,total,total_pages:Math.ceil(total/limit),suppliers:rows,filters:{statuses:['active','inactive']}};
}
function supplierShipments(id){return all(`SELECT s.id,s.tracking_number,s.carrier,s.carrier_code,COALESCE(c.name,s.carrier) carrier_name,s.status,s.origin_city,s.destination_city,s.origin_warehouse_id,s.destination_warehouse_id,ow.code origin_warehouse_code,ow.name origin_warehouse_name,dw.code destination_warehouse_code,dw.name destination_warehouse_name,s.estimated_departure,s.actual_departure,s.estimated_arrival,s.actual_arrival,s.created_at,s.data_origin,(SELECT COUNT(*) FROM shipment_items si WHERE si.shipment_id=s.id) item_count,(SELECT COALESCE(SUM(si.quantity),0) FROM shipment_items si WHERE si.shipment_id=s.id) item_quantity FROM shipments s LEFT JOIN carriers c ON c.carrier_code=s.carrier_code LEFT JOIN warehouses ow ON ow.id=s.origin_warehouse_id LEFT JOIN warehouses dw ON dw.id=s.destination_warehouse_id WHERE s.supplier_id=? ORDER BY s.created_at DESC,s.id`,id);}
function supplierDisruptions(id,supplier){return all(`SELECT d.id,d.disruption_code,d.title,d.disruption_type,d.severity,d.status,d.description,d.detected_at,d.resolved_at,d.shipment_id,s.tracking_number,s.status shipment_status,d.source_entity_type,d.source_entity_id,d.data_origin,(SELECT COUNT(DISTINCT x.customer_order_id) FROM disruption_affected_orders x WHERE x.disruption_id=d.id) affected_orders,(SELECT group_concat(DISTINCT o.order_number) FROM disruption_affected_orders x JOIN customer_orders o ON o.id=x.customer_order_id WHERE x.disruption_id=d.id) affected_order_numbers,(SELECT group_concat(DISTINCT o.id) FROM disruption_affected_orders x JOIN customer_orders o ON o.id=x.customer_order_id WHERE x.disruption_id=d.id) affected_order_ids,(SELECT COUNT(*) FROM recovery_plans rp WHERE rp.disruption_id=d.id) recovery_plans FROM disruptions d LEFT JOIN shipments s ON s.id=d.shipment_id WHERE (d.source_entity_type='SUPPLIER' AND d.source_entity_id=?) OR (s.supplier_id=?) ORDER BY d.detected_at DESC,d.id`,supplier.code,id);}
function supplierProducts(id,params={}){
 const page=params.page||1,limit=params.limit||25,offset=(page-1)*limit,q=params.q||'';
 const join=productJoin(),name=productName();const where=['s.supplier_id=?'],args=[id];if(q){where.push(`(si.sku LIKE ? OR si.item_name LIKE ? ${productTable()?'OR p.name LIKE ? OR p.product_code LIKE ?':''})`);args.push(`%${q}%`,`%${q}%`);if(productTable())args.push(`%${q}%`,`%${q}%`);}
 const clause=`WHERE ${where.join(' AND ')}`;
 const total=n(get(`SELECT COUNT(*) n FROM (SELECT si.sku FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id ${join} ${clause} GROUP BY si.sku)`,...args)?.n);
 const rows=all(`SELECT ${productTable()?'p.product_code':'NULL'} product_code,si.sku,${name} name,${productTable()?'p.category':'NULL'} category,${productTable()?'p.is_active':'NULL'} is_active,${productTable()?'p.data_origin':'MIN(si.data_origin)'} data_origin,COUNT(DISTINCT s.id) linked_shipments,SUM(si.quantity) shipped_quantity FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id ${join} ${clause} GROUP BY si.sku,${productTable()?'p.product_code,p.name,p.category,p.is_active,p.data_origin':'si.item_name'} ORDER BY name,si.sku LIMIT ? OFFSET ?`,...args,limit,offset);
 return {success:true,page,limit,total,total_pages:Math.ceil(total/limit),products:rows,relationship_note:'Products are associated through shipment_items on shipments assigned to this supplier. No direct supplier-product foreign key exists.'};
}
function supplierDetail(id){
 const supplier=get('SELECT id,code,name,country,city,state,region,contact_email,is_active,created_at,data_origin FROM suppliers WHERE id=?',id);if(!supplier)return null;
 const shipments=get(`SELECT COUNT(*) total,SUM(CASE WHEN status='Delivered' THEN 1 ELSE 0 END) delivered,SUM(CASE WHEN status='Delayed' THEN 1 ELSE 0 END) delayed,SUM(CASE WHEN status='In Transit' THEN 1 ELSE 0 END) in_transit FROM shipments WHERE supplier_id=?`,id);
 const disruptions=supplierDisruptions(id,supplier),affected=disruptions.filter(d=>d.shipment_id&&['Active','Investigating'].includes(d.status)).length;
 const products=supplierProducts(id,{page:1,limit:100});
 const recovery=all(`SELECT DISTINCT p.id,p.plan_code,p.title,p.strategy_type,p.status,p.created_at,p.updated_at,p.executed_at,d.id disruption_id,d.disruption_code,(SELECT COUNT(*) FROM recovery_actions ra WHERE ra.recovery_plan_id=p.id) action_count,(SELECT COUNT(*) FROM recovery_actions ra WHERE ra.recovery_plan_id=p.id AND ra.status IN ('Completed','Executed')) completed_actions FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id LEFT JOIN shipments s ON s.id=d.shipment_id WHERE s.supplier_id=? OR (d.source_entity_type='SUPPLIER' AND d.source_entity_id=?) ORDER BY p.created_at DESC`,id,supplier.code);
 return {success:true,supplier,performance:{total_shipments:n(shipments.total),delivered:n(shipments.delivered),delayed:n(shipments.delayed),in_transit:n(shipments.in_transit),disruption_affected_shipments:new Set(disruptions.filter(d=>d.shipment_id&&['Active','Investigating'].includes(d.status)).map(d=>d.shipment_id)).size,linked_disruptions:disruptions.length,linked_products:products.total,recovery_plans:recovery.length},products:products.products,disruptions,recovery,relationship_notes:{shipment:'Direct shipments.supplier_id relationship.',products:'Indirect association through shipment_items on supplier-linked shipments; no supplier-product foreign key.',disruptions:'Supplier source records match disruptions.source_entity_type/source_entity_id; shipment disruptions match disruptions.shipment_id.',orders:'Only disruption_affected_orders records linked to a supplier-related disruption are included; no direct supplier-order relationship.'}};
}
function supplierActivities(id,supplier){
 const shipIds=all('SELECT id FROM shipments WHERE supplier_id=?',id).map(x=>String(x.id));const disIds=supplierDisruptions(id,supplier).map(x=>String(x.id));
 const clauses=[`(lower(entity_type)='supplier' AND entity_id IN (?,?))`],args=[String(id),supplier.code];
 if(shipIds.length){clauses.push(`(lower(entity_type)='shipment' AND entity_id IN (${shipIds.map(()=>'?').join(',')}))`);args.push(...shipIds);}
 if(disIds.length){clauses.push(`(lower(entity_type)='disruption' AND entity_id IN (${disIds.map(()=>'?').join(',')}))`);args.push(...disIds);}
 return all(`SELECT a.id,a.action event_type,a.details description,a.timestamp,a.entity_type,a.entity_id,a.data_origin,u.full_name actor_name,u.username actor_username FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE ${clauses.join(' OR ')} ORDER BY a.timestamp DESC,a.id DESC LIMIT 100`,...args);
}
function supplierCollection(id,type,params={}){const supplier=get('SELECT id,code,name FROM suppliers WHERE id=?',id);if(!supplier)return null;let rows=[];if(type==='products')return {...supplierProducts(id,params),supplier_id:id};if(type==='recovery'){const plans=all(`SELECT DISTINCT p.id,p.plan_code,p.title,p.strategy_type,p.status,p.created_at,p.updated_at,p.executed_at,d.disruption_code,(SELECT COUNT(*) FROM recovery_actions ra WHERE ra.recovery_plan_id=p.id) action_count FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id LEFT JOIN shipments s ON s.id=d.shipment_id WHERE s.supplier_id=? OR (d.source_entity_type='SUPPLIER' AND d.source_entity_id=?) ORDER BY p.created_at DESC`,id,supplier.code);const total=plans.length;return {success:true,page:params.page||1,limit:params.limit||25,total,total_pages:Math.ceil(total/(params.limit||25)),items:plans.slice(((params.page||1)-1)*(params.limit||25),(params.page||1)*(params.limit||25)).map(p=>({...p,actions:all('SELECT id,action_sequence,action_type,description,status,executed_at FROM recovery_actions WHERE recovery_plan_id=? ORDER BY action_sequence',p.id)})),recovery:plans};}if(type==='shipments')rows=supplierShipments(id);else if(type==='disruptions')rows=supplierDisruptions(id,supplier);else if(type==='activities')rows=supplierActivities(id,supplier);else return null;const page=params.page||1,limit=params.limit||25,total=rows.length;return {success:true,page,limit,total,total_pages:Math.ceil(total/limit),items:rows.slice((page-1)*limit,page*limit),[type]:rows.slice((page-1)*limit,page*limit)};}
module.exports={supplierOverview,supplierList,supplierDetail,supplierCollection};
