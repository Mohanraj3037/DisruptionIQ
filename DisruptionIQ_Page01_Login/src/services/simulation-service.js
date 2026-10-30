'use strict';
const crypto = require('node:crypto');
const {get,all,run,nowIso}=require('../database');
const {calculateOrderRisk}=require('../domain/risk-engine');

const TYPES=new Set(['SHIPMENT_DELAY','ROAD_ACCIDENT','SEVERE_WEATHER','SUPPLIER_DISRUPTION','WAREHOUSE_DISRUPTION','INVENTORY_SHORTAGE','CARRIER_DISRUPTION','CUSTOM']);
const positiveId=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
function evaluateSimulation(input,userId,{persist=true}={}){
 const type=String(input.scenario_type||'').toUpperCase();
 if(!TYPES.has(type))return{error:'Choose a supported scenario type.'};
 const delay=Number(input.delay_hours??0);
 if(!Number.isFinite(delay)||delay<0||delay>720)return{error:'Delay must be between 0 and 720 hours.'};
 const shipmentId=positiveId(input.shipment_id),warehouseId=positiveId(input.warehouse_id),supplierId=positiveId(input.supplier_id),disruptionId=positiveId(input.disruption_id);
 const title=String(input.title||type.replaceAll('_',' ')).trim().slice(0,100);
 let shipments=[],orders=[],inventory=[],assumptions=[],missing=[];
 if(['SHIPMENT_DELAY','ROAD_ACCIDENT','SEVERE_WEATHER','CARRIER_DISRUPTION'].includes(type)){
  if(!shipmentId)return{error:'Select a shipment for this scenario.'};
  const shipment=get('SELECT s.*,sp.name AS supplier_name FROM shipments s LEFT JOIN suppliers sp ON sp.id=s.supplier_id WHERE s.id=?',shipmentId);
  if(!shipment)return{error:'Shipment not found.'};
  shipments=[shipment];assumptions.push(`Shipment ${shipment.tracking_number} is hypothetically affected.`);
  const links=all(`SELECT DISTINCT d.id AS disruption_id,x.customer_order_id FROM disruptions d JOIN disruption_affected_orders x ON x.disruption_id=d.id WHERE d.shipment_id=? ${disruptionId?'AND d.id=?':''}`,...(disruptionId?[shipmentId,disruptionId]:[shipmentId]));
  orders=links.map(x=>get('SELECT id,order_number,status,priority,delivery_deadline,assigned_warehouse_id FROM customer_orders WHERE id=?',x.customer_order_id)).filter(Boolean);
  if(!links.length)missing.push('No explicit shipment-to-order association exists for this shipment. Affected customer orders cannot be verified.');
  if(type==='ROAD_ACCIDENT')assumptions.push('Accident is simulated; damage status is unknown and is not inferred.');
  if(type==='SEVERE_WEATHER')missing.push('Alternative route feasibility is unavailable because no verified route dataset is present.');
  if(type==='CARRIER_DISRUPTION')assumptions.push(`Carrier disruption is hypothetical for recorded carrier ${shipment.carrier||'not specified'}.`);
 } else if(type==='SUPPLIER_DISRUPTION'){
  if(!supplierId)return{error:'Select a supplier for this scenario.'};
  const supplier=get('SELECT * FROM suppliers WHERE id=?',supplierId);if(!supplier)return{error:'Supplier not found.'};
  shipments=all('SELECT * FROM shipments WHERE supplier_id=? AND status<>\'Delivered\' ORDER BY id',supplierId);
  if(!shipments.length)missing.push('No non-delivered shipments are linked to this supplier.');
  const ids=shipments.map(x=>x.id);if(ids.length){const placeholders=ids.map(()=>'?').join(',');const links=all(`SELECT DISTINCT x.customer_order_id FROM disruptions d JOIN disruption_affected_orders x ON x.disruption_id=d.id WHERE d.shipment_id IN (${placeholders})`,...ids);orders=links.map(x=>get('SELECT id,order_number,status,priority,delivery_deadline,assigned_warehouse_id FROM customer_orders WHERE id=?',x.customer_order_id)).filter(Boolean);}
  assumptions.push(`Supplier ${supplier.name} is hypothetically delayed.`);if(!orders.length)missing.push('No customer orders are explicitly associated through disruption records.');
 } else if(type==='WAREHOUSE_DISRUPTION'){
  if(!warehouseId)return{error:'Select a warehouse for this scenario.'};
  const wh=get('SELECT * FROM warehouses WHERE id=?',warehouseId);if(!wh)return{error:'Warehouse not found.'};
  shipments=all('SELECT * FROM shipments WHERE (origin_warehouse_id=? OR destination_warehouse_id=?) AND status<>\'Delivered\'',warehouseId,warehouseId);
  orders=all('SELECT id,order_number,status,priority,delivery_deadline,assigned_warehouse_id FROM customer_orders WHERE assigned_warehouse_id=?',warehouseId);
  inventory=all('SELECT sku,item_name,quantity,reserved_quantity,reorder_point,MAX(0,quantity-reserved_quantity) AS available FROM inventories WHERE warehouse_id=? ORDER BY sku',warehouseId);
  assumptions.push(`Warehouse ${wh.code} is hypothetically unavailable.`);
 } else if(type==='INVENTORY_SHORTAGE'){
  if(!warehouseId)return{error:'Select a warehouse for this scenario.'};
  const sku=String(input.sku||'').trim().slice(0,80);if(!sku)return{error:'Enter a SKU for the inventory shortage scenario.'};
  const stock=get('SELECT i.*,w.code AS warehouse_code FROM inventories i JOIN warehouses w ON w.id=i.warehouse_id WHERE i.warehouse_id=? AND i.sku=?',warehouseId,sku);
  if(!stock)return{error:'No matching inventory record exists for that warehouse and SKU.'};
  const assumed=Number(input.assumed_available);
  if(!Number.isInteger(assumed)||assumed<0||assumed>100000000)return{error:'Assumed available quantity must be a non-negative whole number.'};
  orders=all(`SELECT DISTINCT o.id,o.order_number,o.status,o.priority,o.delivery_deadline,o.assigned_warehouse_id FROM customer_orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.assigned_warehouse_id=? AND oi.sku=?`,warehouseId,sku);
  inventory=[{sku:stock.sku,item_name:stock.item_name,current_available:Math.max(0,stock.quantity-stock.reserved_quantity),assumed_available:assumed,projected_shortage:Math.max(0,orders.reduce((n,o)=>n+Number(get('SELECT COALESCE(SUM(quantity),0) AS q FROM order_items WHERE order_id=? AND sku=?',o.id,sku)?.q||0),0)-assumed)}];
  assumptions.push(`Available quantity for ${sku} is hypothetically changed from ${inventory[0].current_available} to ${assumed}; stored inventory is not modified.`);
  shipments=all(`SELECT DISTINCT s.* FROM shipments s JOIN shipment_items si ON si.shipment_id=s.id WHERE si.sku=? AND (s.origin_warehouse_id=? OR s.destination_warehouse_id=?)`,sku,warehouseId,warehouseId);
 } else {
  if(!shipmentId&&!warehouseId&&!supplierId)return{error:'Custom simulation requires a verified shipment, warehouse or supplier target.'};
  assumptions.push('Custom scenario uses only the selected verified target.');
  if(shipmentId){const x=get('SELECT * FROM shipments WHERE id=?',shipmentId);if(!x)return{error:'Shipment not found.'};shipments=[x];}
  if(warehouseId){const x=get('SELECT * FROM warehouses WHERE id=?',warehouseId);if(!x)return{error:'Warehouse not found.'};}
  if(supplierId){const x=get('SELECT * FROM suppliers WHERE id=?',supplierId);if(!x)return{error:'Supplier not found.'};}
  missing.push('Custom assumptions are not mapped to a deterministic operational rule; no projected status changes are calculated.');
 }
 const linkedRisk=[];
 for(const o of orders){
  const pair=all(`SELECT d.id FROM disruptions d JOIN disruption_affected_orders x ON x.disruption_id=d.id WHERE x.customer_order_id=? ${disruptionId?'AND d.id=?':''} ORDER BY d.detected_at DESC LIMIT 1`,...(disruptionId?[o.id,disruptionId]:[o.id]));
  if(pair.length){const risk=calculateOrderRisk(o.id,pair[0].id);if(risk)linkedRisk.push(risk);}
 }
 if(orders.length&&!linkedRisk.length)missing.push('No linked disruption risk assessment is available for these orders; hypothetical risk scores are not fabricated.');
 const result={simulated:true,scenario_type:type,title,assumptions,affected_shipments:shipments.map(s=>({id:s.id,tracking_number:s.tracking_number,status:s.status,carrier:s.carrier})),affected_orders:orders.map(o=>({id:o.id,order_number:o.order_number,status:o.status,priority:o.priority,delivery_deadline:o.delivery_deadline})),inventory_impact:inventory,risk:{assessed_orders:linkedRisk.length,critical:linkedRisk.filter(x=>x.severity==='Critical').length,high:linkedRisk.filter(x=>x.severity==='High').length,medium:linkedRisk.filter(x=>x.severity==='Medium').length,low:linkedRisk.filter(x=>x.severity==='Low').length,scores:linkedRisk.map(x=>({order_id:x.order_id,score:x.final_risk_score,severity:x.severity}))},estimated_delay_hours:['SHIPMENT_DELAY','ROAD_ACCIDENT','SEVERE_WEATHER','CARRIER_DISRUPTION','SUPPLIER_DISRUPTION'].includes(type)?delay:null,recovery_feasibility:'REQUIRES_REVIEW',trade_offs:['This is a hypothetical projection, not an executed recovery.','No real order, shipment, inventory or disruption record was changed.'],missing_information:missing,created_at:nowIso()};
 if(!persist)return{result};
 const code=`SIM-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
 const parameters={scenario_type:type,title,shipment_id:shipmentId,warehouse_id:warehouseId,supplier_id:supplierId,disruption_id:disruptionId,delay_hours:delay,sku:input.sku||null,assumed_available:input.assumed_available??null};
 const saved=run('INSERT INTO simulation_runs(simulation_code,created_by_id,scenario_type,title,parameters_json,result_json,created_at,data_origin) VALUES(?,?,?,?,?,?,?,\'simulated\')',code,userId,type,title,JSON.stringify(parameters),JSON.stringify(result),result.created_at);
 return{simulation:{id:Number(saved.lastInsertRowid),simulation_code:code,...result,parameters,result}};
}
function listSimulations(){return all('SELECT id,simulation_code,scenario_type,title,parameters_json,result_json,created_at,data_origin FROM simulation_runs ORDER BY created_at DESC LIMIT 100').map(x=>({id:x.id,simulation_code:x.simulation_code,scenario_type:x.scenario_type,title:x.title,parameters:JSON.parse(x.parameters_json),result:JSON.parse(x.result_json),created_at:x.created_at,data_origin:x.data_origin}));}
function getSimulation(id){const x=get('SELECT * FROM simulation_runs WHERE id=?',id);return x?{id:x.id,simulation_code:x.simulation_code,scenario_type:x.scenario_type,title:x.title,parameters:JSON.parse(x.parameters_json),result:JSON.parse(x.result_json),created_at:x.created_at,data_origin:x.data_origin}:null;}
module.exports={evaluateSimulation,listSimulations,getSimulation};
