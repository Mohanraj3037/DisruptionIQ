'use strict';
const {all,get}=require('../database');
const ACTIVE="('Active','Investigating')";
const n=v=>Number(v||0);
const availableSql='MAX(0,i.quantity-i.reserved_quantity)';
function hubRows(){
 const warehouses=all('SELECT id,code,name,location,is_active,capacity_sqm,current_utilization,capacity_units,created_at,data_origin FROM warehouses ORDER BY code');
 return warehouses.map(w=>{
  const shipmentStats=get(`SELECT COUNT(DISTINCT s.id) total,
   COUNT(DISTINCT CASE WHEN s.status='In Transit' THEN s.id END) in_transit,
   COUNT(DISTINCT CASE WHEN s.status='Delivered' THEN s.id END) delivered,
   COUNT(DISTINCT CASE WHEN s.status='Delayed' THEN s.id END) delayed,
   COUNT(DISTINCT CASE WHEN s.status NOT IN ('Delivered','Cancelled') AND EXISTS(SELECT 1 FROM disruptions dx WHERE dx.status IN ${ACTIVE} AND dx.shipment_id=s.id) THEN s.id END) disrupted,
   COUNT(DISTINCT CASE WHEN s.status NOT IN ('Delivered','Cancelled') AND lower(COALESCE(s.ui_status,'')) IN ('at risk','atrisk') AND NOT EXISTS(SELECT 1 FROM disruptions dx WHERE dx.status IN ${ACTIVE} AND dx.shipment_id=s.id) THEN s.id END) at_risk
   FROM shipments s WHERE s.origin_warehouse_id=? OR s.destination_warehouse_id=?`,w.id,w.id);
  const disruptionStats=get(`SELECT COUNT(DISTINCT d.id) total,
   COUNT(DISTINCT CASE WHEN d.severity='Critical' THEN d.id END) critical,
   COUNT(DISTINCT CASE WHEN d.severity='High' THEN d.id END) high,
   COUNT(DISTINCT CASE WHEN d.severity='Medium' THEN d.id END) medium,
   COUNT(DISTINCT CASE WHEN d.severity='Low' THEN d.id END) low,
   COUNT(DISTINCT CASE WHEN d.disruption_type IS NOT NULL THEN d.disruption_type END) categories,
   COUNT(DISTINCT CASE WHEN ds.origin_warehouse_id=? OR ds.destination_warehouse_id=? THEN d.shipment_id END) affected_shipments,
   COUNT(DISTINCT x.customer_order_id) affected_orders,
   MAX(d.detected_at) latest_incident
   FROM disruptions d LEFT JOIN shipments ds ON ds.id=d.shipment_id LEFT JOIN disruption_affected_orders x ON x.disruption_id=d.id
   WHERE d.status IN ${ACTIVE} AND (d.warehouse_id=? OR EXISTS(SELECT 1 FROM shipments sx WHERE sx.id=d.shipment_id AND (sx.origin_warehouse_id=? OR sx.destination_warehouse_id=?)) OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?))`,w.id,w.id,w.id,w.id,w.id,w.id);
  const categoryDistribution=all(`SELECT d.disruption_type category,COUNT(DISTINCT d.id) count FROM disruptions d LEFT JOIN shipments sx ON sx.id=d.shipment_id WHERE d.status IN ${ACTIVE} AND (d.warehouse_id=? OR (sx.origin_warehouse_id=? OR sx.destination_warehouse_id=?) OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?)) GROUP BY d.disruption_type ORDER BY count DESC`,w.id,w.id,w.id,w.id).map(x=>({category:x.category||'Unspecified',count:n(x.count)}));
  const inventoryStats=get(`SELECT COUNT(*) tracked_items,
   COALESCE(SUM(${availableSql}),0) available_units,
   COUNT(DISTINCT CASE WHEN ${availableSql}>0 AND ${availableSql}<=i.reorder_point THEN i.sku END) low_stock_products,
   COUNT(DISTINCT CASE WHEN ${availableSql}=0 THEN i.sku END) out_of_stock_products,
   COUNT(DISTINCT i.sku) products
   FROM inventories i WHERE i.warehouse_id=?`,w.id);
  const shortageOrders=get(`SELECT COUNT(DISTINCT o.id) n FROM customer_orders o
   JOIN order_items oi ON oi.order_id=o.id
   LEFT JOIN inventories i ON i.warehouse_id=o.assigned_warehouse_id AND i.sku=oi.sku
   WHERE o.assigned_warehouse_id=? AND (i.id IS NULL OR MAX(0,i.quantity-i.reserved_quantity)<oi.quantity)`,w.id);
  const recovery=get(`SELECT COUNT(DISTINCT p.id) plans,
   COUNT(DISTINCT CASE WHEN p.status='Pending Approval' OR a.status='Pending' THEN p.id END) pending_approvals,
   COUNT(DISTINCT CASE WHEN p.status IN ('Approved','Execution Ready','Executing') THEN p.id END) approved_plans,
   COUNT(DISTINCT CASE WHEN ra.status IN ('In Progress','Executing') THEN ra.id END) actions_in_progress,
   COUNT(DISTINCT CASE WHEN ra.status='Completed' THEN ra.id END) completed_actions,
   COUNT(DISTINCT CASE WHEN ra.status IN ('Blocked','Failed') THEN ra.id END) blocked_or_failed_actions
   FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id
   LEFT JOIN approvals a ON a.recovery_plan_id=p.id LEFT JOIN recovery_actions ra ON ra.recovery_plan_id=p.id
   LEFT JOIN shipments rs ON rs.id=d.shipment_id
   WHERE d.warehouse_id=? OR (rs.origin_warehouse_id=? OR rs.destination_warehouse_id=?) OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?)`,w.id,w.id,w.id,w.id);
  const activeDisruptions=n(disruptionStats.total), delayed=n(shipmentStats.delayed), low=n(inventoryStats.low_stock_products),out=n(inventoryStats.out_of_stock_products),backlog=n(recovery.actions_in_progress)+n(recovery.blocked_or_failed_actions);
  const health=out>0||(delayed>0&&activeDisruptions>0)||delayed/Math.max(1,n(shipmentStats.total))>=0.25||activeDisruptions>=3?'Critical':(delayed>0||activeDisruptions>0||low>0||backlog>0?'Watch':'Healthy');
  const shipment={total:n(shipmentStats.total),in_transit:n(shipmentStats.in_transit),delivered:n(shipmentStats.delivered),delayed,disrupted:n(shipmentStats.disrupted),at_risk:n(shipmentStats.at_risk)};
  const disruptions={total:activeDisruptions,critical:n(disruptionStats.critical),high:n(disruptionStats.high),medium:n(disruptionStats.medium),low:n(disruptionStats.low),category_distribution:categoryDistribution,affected_shipments:n(disruptionStats.affected_shipments),affected_orders:n(disruptionStats.affected_orders),latest_incident:disruptionStats.latest_incident||null};
  const inventory={tracked_items:n(inventoryStats.tracked_items),available_units:n(inventoryStats.available_units),low_stock_products:low,out_of_stock_products:out,shortage_orders:n(shortageOrders.n),products:n(inventoryStats.products)};
  const recoveryStats=Object.fromEntries(Object.entries(recovery).map(([k,v])=>[k,n(v)]));
  return {id:w.id,hub_id:w.id,hub_code:w.code,hub_name:w.name,location:w.location||null,status:Number(w.is_active)?'Active':'Inactive',is_active:Number(w.is_active)===1,
   capacity_sqm:w.capacity_sqm??null,current_utilization:w.current_utilization??null,capacity_units:w.capacity_units??null,data_origin:w.data_origin||'operational',
   shipment,disruptions,inventory,recovery:recoveryStats,health_status:health};
 });
}
function getHubOverview(){
 const hubs=hubRows();
 const totalShipments=n(get('SELECT COUNT(DISTINCT id) n FROM shipments WHERE origin_warehouse_id IS NOT NULL OR destination_warehouse_id IS NOT NULL').n);
 const activeDisruptions=n(get(`SELECT COUNT(DISTINCT d.id) n FROM disruptions d WHERE d.status IN ${ACTIVE} AND (d.warehouse_id IS NOT NULL OR EXISTS(SELECT 1 FROM shipments s WHERE s.id=d.shipment_id AND (s.origin_warehouse_id IS NOT NULL OR s.destination_warehouse_id IS NOT NULL)) OR EXISTS(SELECT 1 FROM inventories i WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND i.source_record_id=d.source_entity_id))`).n);
 const affectedOrders=n(get(`SELECT COUNT(DISTINCT x.customer_order_id) n FROM disruption_affected_orders x JOIN disruptions d ON d.id=x.disruption_id WHERE d.status IN ${ACTIVE} AND (d.warehouse_id IS NOT NULL OR EXISTS(SELECT 1 FROM shipments s WHERE s.id=d.shipment_id AND (s.origin_warehouse_id IS NOT NULL OR s.destination_warehouse_id IS NOT NULL)) OR EXISTS(SELECT 1 FROM inventories i WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND i.source_record_id=d.source_entity_id))`).n);
 const inv=get(`SELECT COUNT(*) tracked_items,COALESCE(SUM(MAX(0,quantity-reserved_quantity)),0) available_units,
  COUNT(DISTINCT CASE WHEN MAX(0,quantity-reserved_quantity)>0 AND MAX(0,quantity-reserved_quantity)<=reorder_point THEN sku END) low_stock_products,
  COUNT(DISTINCT CASE WHEN MAX(0,quantity-reserved_quantity)=0 THEN sku END) out_of_stock_products FROM inventories`);
 const shortageOrders=n(get(`SELECT COUNT(DISTINCT o.id) n FROM customer_orders o JOIN order_items oi ON oi.order_id=o.id LEFT JOIN inventories i ON i.warehouse_id=o.assigned_warehouse_id AND i.sku=oi.sku WHERE o.assigned_warehouse_id IS NOT NULL AND (i.id IS NULL OR MAX(0,i.quantity-i.reserved_quantity)<oi.quantity)`).n);
 const recovery=get(`SELECT COUNT(DISTINCT CASE WHEN ra.status IN ('In Progress','Executing') THEN ra.id END) actions_in_progress FROM recovery_actions ra JOIN recovery_plans p ON p.id=ra.recovery_plan_id JOIN disruptions d ON d.id=p.disruption_id LEFT JOIN shipments s ON s.id=d.shipment_id WHERE d.warehouse_id IS NOT NULL OR s.origin_warehouse_id IS NOT NULL OR s.destination_warehouse_id IS NOT NULL OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id)`);
 return {success:true,summary:{total_hubs:hubs.length,active_hubs:hubs.filter(h=>h.is_active).length,total_shipments:totalShipments,delayed_shipments:n(get("SELECT COUNT(*) n FROM shipments WHERE status='Delayed' AND (origin_warehouse_id IS NOT NULL OR destination_warehouse_id IS NOT NULL)").n),active_disruptions:activeDisruptions,affected_customer_orders:affectedOrders,inventory_tracked_items:n(inv.tracked_items),available_stock_units:n(inv.available_units),low_stock_products:n(inv.low_stock_products),out_of_stock_products:n(inv.out_of_stock_products),stock_shortage_orders:shortageOrders,recovery_actions_in_progress:n(recovery.actions_in_progress)},health_distribution:{healthy:hubs.filter(h=>h.health_status==='Healthy').length,watch:hubs.filter(h=>h.health_status==='Watch').length,critical:hubs.filter(h=>h.health_status==='Critical').length},hub_count:hubs.length,last_updated:new Date().toISOString()};
}
function listHubs(params={}){
 let rows=hubRows();const q=String(params.q||'').trim().toLowerCase(),status=String(params.status||'').trim().toLowerCase(),health=String(params.health||'').trim().toLowerCase(),disruption=String(params.disruption||'').trim().toLowerCase();
 if(q)rows=rows.filter(h=>`${h.hub_id} ${h.hub_code} ${h.hub_name} ${h.location||''}`.toLowerCase().includes(q));
 if(status==='active'||status==='inactive')rows=rows.filter(h=>h.status.toLowerCase()===status);
 if(health&&['healthy','watch','critical'].includes(health))rows=rows.filter(h=>h.health_status.toLowerCase()===health);
 if(disruption==='active')rows=rows.filter(h=>h.disruptions.total>0);if(disruption==='none')rows=rows.filter(h=>h.disruptions.total===0);
 const total=rows.length,limit=Math.min(100,Math.max(1,Number(params.limit)||25)),page=Math.max(1,Number(params.page)||1),offset=(page-1)*limit;
 return {success:true,total,page,limit,total_pages:Math.ceil(total/limit),hubs:rows.slice(offset,offset+limit)};
}
function getHubById(id){const hub=hubRows().find(h=>h.id===id);if(!hub)return null;
 const disruptions=all(`SELECT DISTINCT d.id,d.disruption_code,d.title,d.disruption_type,d.severity,d.status,d.detected_at,d.shipment_id,s.tracking_number,COUNT(DISTINCT x.customer_order_id) affected_orders
  FROM disruptions d LEFT JOIN shipments s ON s.id=d.shipment_id LEFT JOIN disruption_affected_orders x ON x.disruption_id=d.id
  WHERE d.status IN ${ACTIVE} AND (d.warehouse_id=? OR (s.origin_warehouse_id=? OR s.destination_warehouse_id=?) OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?))
  GROUP BY d.id ORDER BY d.detected_at DESC`,id,id,id,id);
 const plans=all(`SELECT DISTINCT p.id,p.plan_code,p.title,p.status,p.created_at,d.disruption_code,COUNT(DISTINCT ra.id) action_count
  FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id LEFT JOIN shipments s ON s.id=d.shipment_id LEFT JOIN recovery_actions ra ON ra.recovery_plan_id=p.id
  WHERE d.warehouse_id=? OR (s.origin_warehouse_id=? OR s.destination_warehouse_id=?) OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?) GROUP BY p.id ORDER BY p.created_at DESC`,id,id,id,id);
 const shipments=all(`SELECT DISTINCT s.id,s.tracking_number,s.status,s.carrier,s.origin_city,s.destination_city,s.estimated_arrival,s.risk_score,s.ui_status
  FROM shipments s WHERE s.origin_warehouse_id=? OR s.destination_warehouse_id=? ORDER BY s.created_at DESC LIMIT 100`,id,id);
 const inventory=all(`SELECT i.id,i.sku,i.item_name,i.quantity,i.reserved_quantity,MAX(0,i.quantity-i.reserved_quantity) available_quantity,i.reorder_point,
  CASE WHEN MAX(0,i.quantity-i.reserved_quantity)=0 THEN 'Out of stock' WHEN MAX(0,i.quantity-i.reserved_quantity)<=i.reorder_point THEN 'Low stock' ELSE 'Available' END stock_status
  FROM inventories i WHERE i.warehouse_id=? ORDER BY CASE WHEN MAX(0,i.quantity-i.reserved_quantity)=0 THEN 0 WHEN MAX(0,i.quantity-i.reserved_quantity)<=i.reorder_point THEN 1 ELSE 2 END,i.sku LIMIT 100`,id);
 const affectedOrders=all(`SELECT DISTINCT o.id,o.order_number,o.status,o.priority,o.delivery_deadline FROM customer_orders o
  JOIN disruption_affected_orders x ON x.customer_order_id=o.id JOIN disruptions d ON d.id=x.disruption_id LEFT JOIN shipments s ON s.id=d.shipment_id
  WHERE d.status IN ${ACTIVE} AND (d.warehouse_id=? OR s.origin_warehouse_id=? OR s.destination_warehouse_id=? OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?)) ORDER BY o.delivery_deadline LIMIT 100`,id,id,id,id);
 return {...hub,disruption_records:disruptions,recovery_plans:plans,shipments,inventory_records:inventory,affected_order_records:affectedOrders};
}
function getHubActivities(id,limit=20,offset=0){
 const hub=get('SELECT id FROM warehouses WHERE id=?',id);if(!hub)return null;
 return all(`SELECT a.id,a.action,a.entity_type,a.entity_id,a.details,a.timestamp,a.data_origin,u.full_name,u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
  WHERE (a.entity_type='Shipment' AND a.entity_id IN (SELECT CAST(id AS TEXT) FROM shipments WHERE origin_warehouse_id=? OR destination_warehouse_id=?))
   OR (a.entity_type='Disruption' AND a.entity_id IN (SELECT CAST(d.id AS TEXT) FROM disruptions d LEFT JOIN shipments s ON s.id=d.shipment_id WHERE d.warehouse_id=? OR s.origin_warehouse_id=? OR s.destination_warehouse_id=? OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?)))
   OR (a.entity_type='RecoveryPlan' AND a.entity_id IN (SELECT CAST(p.id AS TEXT) FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id LEFT JOIN shipments s ON s.id=d.shipment_id WHERE d.warehouse_id=? OR s.origin_warehouse_id=? OR s.destination_warehouse_id=? OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?)))
   OR (a.entity_type='Inventory' AND a.entity_id IN (SELECT CAST(id AS TEXT) FROM inventories WHERE warehouse_id=?))
  ORDER BY a.timestamp DESC,a.id DESC LIMIT ? OFFSET ?`,id,id,id,id,id,id,id,id,id,id,id,Math.min(10000,Math.max(1,Number(limit)||20)),Math.max(0,Number(offset)||0))
  .map(a=>({id:a.id,type:a.action,entity_type:a.entity_type,entity_id:a.entity_id,description:a.details||a.action,timestamp:a.timestamp,actor:a.full_name||a.username||'System',data_origin:a.data_origin||'operational'}));
}

function hubExists(id){return !!get('SELECT id FROM warehouses WHERE id=?',id);}
function getHubDetails(id){
 const hub=getHubById(id);if(!hub)return null;
 const counts=get(`SELECT
  (SELECT COUNT(*) FROM shipments s WHERE s.origin_warehouse_id=? OR s.destination_warehouse_id=?) shipment_count,
  (SELECT COUNT(*) FROM inventories i WHERE i.warehouse_id=?) inventory_count,
  (SELECT COUNT(DISTINCT p.id) FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id LEFT JOIN shipments s ON s.id=d.shipment_id WHERE d.warehouse_id=? OR s.origin_warehouse_id=? OR s.destination_warehouse_id=? OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?)) recovery_plan_count`,id,id,id,id,id,id,id);
 return {...hub,performance:{...hub.shipment,inventory_records:n(counts.inventory_count),recovery_plans:n(counts.recovery_plan_count)},metadata:{capacity_sqm:hub.capacity_sqm,current_utilization:hub.current_utilization,capacity_units:hub.capacity_units,created_at:hub.created_at,data_origin:hub.data_origin},relationship_notes:{shipment_association:'A shipment is associated once when this warehouse is its origin or destination.',order_association:'Orders are linked by assigned warehouse or an affected-order relationship on a disruption associated with this warehouse. The schema has no direct shipment-to-order foreign key.',disruption_association:'Disruptions are linked by warehouse_id, shipment origin/destination, or a source inventory record resolving to this warehouse.',inventory_association:'Inventory is linked by inventories.warehouse_id.'}};
}
function getHubCollection(id,type,params={}){
 if(!hubExists(id))return null;
 const q=String(params.q||'').trim().toLowerCase();
 const status=String(params.status||'').trim().toLowerCase();
 const page=Math.max(1,Number(params.page)||1),limit=Math.min(100,Math.max(1,Number(params.limit)||25)),offset=(page-1)*limit;
 let rows=[];
 if(type==='shipments'){
  rows=all(`SELECT s.id,s.tracking_number,s.status,s.carrier,s.carrier_code,s.transport_mode,s.origin_city,s.destination_city,s.estimated_departure,s.actual_departure,s.estimated_arrival,s.actual_arrival,s.created_at,s.risk_score,s.ui_status,
   s.origin_warehouse_id,s.destination_warehouse_id,ow.code origin_warehouse_code,ow.name origin_warehouse_name,dw.code destination_warehouse_code,dw.name destination_warehouse_name,
   (SELECT COUNT(DISTINCT d.id) FROM disruptions d WHERE d.shipment_id=s.id) disruption_count,
   (SELECT COUNT(DISTINCT x.customer_order_id) FROM disruptions d JOIN disruption_affected_orders x ON x.disruption_id=d.id WHERE d.shipment_id=s.id) associated_order_count
   FROM shipments s LEFT JOIN warehouses ow ON ow.id=s.origin_warehouse_id LEFT JOIN warehouses dw ON dw.id=s.destination_warehouse_id
   WHERE s.origin_warehouse_id=? OR s.destination_warehouse_id=? ORDER BY s.created_at DESC,s.id DESC`,id,id);
 }else if(type==='disruptions'){
  rows=all(`SELECT d.id,d.disruption_code,d.title,d.disruption_type,d.severity,d.status,d.description,d.detected_at,d.resolved_at,d.shipment_id,d.warehouse_id,s.tracking_number,
   COUNT(DISTINCT x.customer_order_id) affected_orders,
   (SELECT COUNT(DISTINCT p.id) FROM recovery_plans p WHERE p.disruption_id=d.id) recovery_plans,
   (SELECT COUNT(DISTINCT ra.id) FROM recovery_actions ra JOIN recovery_plans p ON p.id=ra.recovery_plan_id WHERE p.disruption_id=d.id AND ra.status IN ('In Progress','Executing')) recovery_actions_in_progress
   FROM disruptions d LEFT JOIN shipments s ON s.id=d.shipment_id LEFT JOIN disruption_affected_orders x ON x.disruption_id=d.id
   WHERE d.warehouse_id=? OR EXISTS(SELECT 1 FROM shipments sx WHERE sx.id=d.shipment_id AND (sx.origin_warehouse_id=? OR sx.destination_warehouse_id=?)) OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?)
   GROUP BY d.id ORDER BY d.detected_at DESC,d.id DESC`,id,id,id,id);
 }else if(type==='inventory'){
  rows=all(`SELECT i.id,i.source_record_id,i.sku,i.item_name,i.category,i.quantity,i.reserved_quantity,MAX(0,i.quantity-i.reserved_quantity) available_quantity,i.reorder_point,i.unit_cost,i.updated_at,i.data_origin,
   CASE WHEN MAX(0,i.quantity-i.reserved_quantity)=0 THEN 'Out of stock' WHEN MAX(0,i.quantity-i.reserved_quantity)<=i.reorder_point THEN 'Low stock' ELSE 'Available' END stock_status,
   (SELECT COUNT(DISTINCT o.id) FROM customer_orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.assigned_warehouse_id=i.warehouse_id AND oi.sku=i.sku AND oi.quantity>MAX(0,i.quantity-i.reserved_quantity)) shortage_order_count
   FROM inventories i WHERE i.warehouse_id=? ORDER BY CASE WHEN MAX(0,i.quantity-i.reserved_quantity)=0 THEN 0 WHEN MAX(0,i.quantity-i.reserved_quantity)<=i.reorder_point THEN 1 ELSE 2 END,i.sku`,id);
 }else if(type==='orders'){
  rows=all(`SELECT DISTINCT o.id,o.order_number,o.status,o.priority,o.order_date,o.delivery_deadline,o.assigned_warehouse_id,w.code assigned_warehouse_code,
   (SELECT GROUP_CONCAT(DISTINCT d.disruption_code) FROM disruptions d JOIN disruption_affected_orders dx ON dx.disruption_id=d.id LEFT JOIN shipments ss ON ss.id=d.shipment_id WHERE dx.customer_order_id=o.id AND (d.warehouse_id=? OR ss.origin_warehouse_id=? OR ss.destination_warehouse_id=? OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?))) disruption_codes
   FROM customer_orders o LEFT JOIN warehouses w ON w.id=o.assigned_warehouse_id
   WHERE o.assigned_warehouse_id=? OR EXISTS(SELECT 1 FROM disruption_affected_orders x JOIN disruptions d ON d.id=x.disruption_id LEFT JOIN shipments ss ON ss.id=d.shipment_id WHERE x.customer_order_id=o.id AND (d.warehouse_id=? OR ss.origin_warehouse_id=? OR ss.destination_warehouse_id=? OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?)))
   ORDER BY o.delivery_deadline,o.id`,id,id,id,id,id,id,id,id,id);
  const riskRows=all(`SELECT x.customer_order_id,d.id disruption_id FROM disruption_affected_orders x JOIN disruptions d ON d.id=x.disruption_id LEFT JOIN shipments s ON s.id=d.shipment_id WHERE d.status IN ${ACTIVE} AND (d.warehouse_id=? OR s.origin_warehouse_id=? OR s.destination_warehouse_id=? OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?))`,id,id,id,id);
  const {calculateOrderRisk}=require('../domain/risk-engine');const riskMap=new Map();const cache={orders:new Map(),disruptions:new Map(),inventory:new Map(),demand:new Map(),alternatives:new Map()};
  for(const pair of riskRows){const r=calculateOrderRisk(pair.customer_order_id,pair.disruption_id,new Date(),cache);if(r){const old=riskMap.get(r.order_id);if(!old||r.final_risk_score>old.final_risk_score)riskMap.set(r.order_id,r);}}
  rows=rows.map(o=>{const r=riskMap.get(o.id);return {...o,risk_classification:r?.severity||null,risk_score:r?.final_risk_score??null};});
 }else if(type==='recovery'){
  rows=all(`SELECT p.id,p.plan_code,p.title,p.status,p.strategy_type,p.description,p.priority,p.progress,p.created_at,p.updated_at,p.executed_at,p.execution_notes,d.disruption_code,d.title disruption_title,d.severity disruption_severity,
   a.status approval_status,a.requested_at approval_requested_at,a.decision_at approval_decision_at,
   ra.id action_id,ra.action_sequence,ra.action_type,ra.description action_description,ra.status action_status,ra.executed_at action_executed_at,ra.result_details action_result,
   (SELECT COUNT(*) FROM recovery_actions x WHERE x.recovery_plan_id=p.id) action_count,
   (SELECT COUNT(*) FROM recovery_actions x WHERE x.recovery_plan_id=p.id AND x.status='Completed') completed_actions
   FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id LEFT JOIN approvals a ON a.id=(SELECT aa.id FROM approvals aa WHERE aa.recovery_plan_id=p.id ORDER BY aa.requested_at DESC LIMIT 1) LEFT JOIN recovery_actions ra ON ra.recovery_plan_id=p.id
   LEFT JOIN shipments s ON s.id=d.shipment_id
   WHERE d.warehouse_id=? OR s.origin_warehouse_id=? OR s.destination_warehouse_id=? OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?)
   ORDER BY p.created_at DESC,p.id DESC,ra.action_sequence`,id,id,id,id);
 }else if(type==='activities'){
  rows=getHubActivities(id,10000,0);
 }else return {error:'Unknown hub collection.'};
 if(q){rows=rows.filter(r=>JSON.stringify(r).toLowerCase().includes(q));}
 if(status){rows=rows.filter(r=>String(r.status||r.stock_status||r.action_status||r.approval_status||'').toLowerCase()===status);}
 const total=rows.length;
 return {success:true,hub_id:id,type,items:rows.slice(offset,offset+limit),total,page,limit,total_pages:Math.ceil(total/limit)};
}

module.exports={getHubOverview,listHubs,getHubById,getHubActivities,getHubDetails,getHubCollection};
