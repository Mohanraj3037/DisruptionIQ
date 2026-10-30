'use strict';
const {get,all}=require('../database');
const {scoreAndRankAllAffectedOrders}=require('./risk-engine');

function isoHours(value,now){if(!value)return null;const t=new Date(value).getTime();return Number.isNaN(t)?null:(t-now.getTime())/3600000;}
function analyzeDisruptionImpact(disruptionId){
 const d=get(`SELECT d.*,s.tracking_number,s.carrier,s.transport_mode,s.origin_city,s.destination_city,s.status AS shipment_status,s.supplier_id,s.destination_warehouse_id,s.estimated_departure,s.actual_departure,s.estimated_arrival,s.actual_arrival,w.code AS warehouse_code,w.name AS warehouse_name,w.location AS warehouse_location,w.capacity_sqm,w.current_utilization FROM disruptions d LEFT JOIN shipments s ON s.id=d.shipment_id LEFT JOIN warehouses w ON w.id=COALESCE(d.warehouse_id,s.destination_warehouse_id) WHERE d.id=?`,Number(disruptionId));
 if(!d)return{error:`Disruption with ID ${disruptionId} not found.`,disruption_id:disruptionId};
 const now=new Date();
 const disruption={id:d.id,disruption_code:d.disruption_code,title:d.title,disruption_type:d.disruption_type,status:d.status,severity:d.severity,shortage_category:d.shortage_category,location:d.location||'Unknown',description:d.description||'No description provided.',estimated_delay_hours:Number(d.estimated_delay_hours||0),detected_at:d.detected_at||null};
 let shipment=null,supplier=null;const skuSet=new Set();
 const cargo=d.shipment_id?all('SELECT * FROM shipment_items WHERE shipment_id=? ORDER BY id',d.shipment_id):[];
 if(d.shipment_id){shipment={id:d.shipment_id,tracking_number:d.tracking_number,carrier:d.carrier||'Unknown Carrier',transport_mode:d.transport_mode||'Unknown',status:d.shipment_status,origin_city:d.origin_city||'Unknown Origin',destination_city:d.destination_city||'Unknown Destination',estimated_departure:d.estimated_departure,actual_departure:d.actual_departure,estimated_arrival:d.estimated_arrival,actual_arrival:d.actual_arrival,is_delayed:d.shipment_status==='Delayed',cargo_items:cargo.map(x=>({sku:x.sku,item_name:x.item_name,quantity:x.quantity}))};for(const item of cargo)skuSet.add(item.sku);}
 if(d.supplier_id){const x=get('SELECT * FROM suppliers WHERE id=?',d.supplier_id);if(x)supplier={id:x.id,code:x.code,name:x.name,country:x.country||'Unknown',city:x.city||'Unknown',reliability_score:x.reliability_score,lead_time_days:x.lead_time_days,expected_supply_date:x.expected_supply_date};}
 const warehouseId=d.warehouse_id||d.destination_warehouse_id||null;
 const warehouse=warehouseId?get('SELECT * FROM warehouses WHERE id=?',warehouseId):null;
 const affectedRows=all(`SELECT o.* FROM customer_orders o JOIN disruption_affected_orders x ON x.customer_order_id=o.id WHERE x.disruption_id=?`,d.id);
 for(const order of affectedRows){const items=all('SELECT sku FROM order_items WHERE order_id=?',order.id);for(const item of items){if(!skuSet.size||skuSet.has(item.sku))skuSet.add(item.sku);}}
 if(!skuSet.size&&warehouse){const invs=all('SELECT sku FROM inventories WHERE warehouse_id=?',warehouse.id);for(const inv of invs){if(String(d.title||'').includes(inv.sku)||String(d.description||'').includes(inv.sku))skuSet.add(inv.sku);}}
 const affectedSkus=[...skuSet].sort();
 const inventoryBalances={},incomingSupply=[],alternativeWarehouses=[];
 if(warehouse){
  const inbound=all(`SELECT * FROM shipments WHERE destination_warehouse_id=? AND status IN ('In Transit','Delayed','Scheduled') ORDER BY created_at DESC`,warehouse.id);
  for(const sku of affectedSkus){
   const inv=get('SELECT * FROM inventories WHERE warehouse_id=? AND sku=?',warehouse.id,sku);
   inventoryBalances[sku]=inv?{sku:inv.sku,item_name:inv.item_name,category:inv.category,quantity_on_hand:inv.quantity,reserved_quantity:inv.reserved_quantity,available_quantity:Math.max(0,inv.quantity-inv.reserved_quantity),reorder_point:inv.reorder_point,unit_cost:inv.unit_cost,is_low_stock:Math.max(0,inv.quantity-inv.reserved_quantity)<=inv.reorder_point}:{sku,item_name:'Unknown / Unstocked SKU',category:'Unknown',quantity_on_hand:0,reserved_quantity:0,available_quantity:0,reorder_point:0,unit_cost:0,is_low_stock:true};
   for(const inboundShip of inbound){for(const item of all('SELECT * FROM shipment_items WHERE shipment_id=? AND sku=?',inboundShip.id,sku)){incomingSupply.push({shipment_id:inboundShip.id,tracking_number:inboundShip.tracking_number,carrier:inboundShip.carrier,sku:item.sku,quantity:item.quantity,status:inboundShip.status,estimated_arrival:inboundShip.estimated_arrival||'Unknown',is_delayed:inboundShip.status==='Delayed'});}}
   const alts=all('SELECT i.*,w.code AS warehouse_code,w.name AS warehouse_name,w.location AS warehouse_location FROM inventories i JOIN warehouses w ON w.id=i.warehouse_id WHERE i.warehouse_id<>? AND i.sku=?',warehouse.id,sku);
   for(const a of alts){const av=Math.max(0,a.quantity-a.reserved_quantity),surplus=Math.max(0,av-a.reorder_point);alternativeWarehouses.push({warehouse_id:a.warehouse_id,warehouse_code:a.warehouse_code,warehouse_name:a.warehouse_name,warehouse_location:a.warehouse_location,sku,item_name:a.item_name,total_quantity:a.quantity,reserved_quantity:a.reserved_quantity,available_quantity:av,reorder_point:a.reorder_point,surplus_available:surplus,can_transfer:surplus>0});}
  }
 }
 const totalSkuDemand=Object.fromEntries(affectedSkus.map(s=>[s,0]));
 const ordersAffected=affectedRows.map(order=>{
  const hours=isoHours(order.delivery_deadline,now);
  const items=all('SELECT * FROM order_items WHERE order_id=? ORDER BY id',order.id);
  let affectedQuantity=0;
  const itemDetails=items.map(item=>{const isAffected=affectedSkus.includes(item.sku);if(isAffected){totalSkuDemand[item.sku]=(totalSkuDemand[item.sku]||0)+Number(item.quantity||0);affectedQuantity+=Number(item.quantity||0);}return{sku:item.sku,item_name:item.item_name,quantity:item.quantity,unit_price:item.unit_price,line_total:Number(item.quantity||0)*Number(item.unit_price||0),is_affected:isAffected};});
  return{id:order.id,order_id:order.id,order_number:order.order_number,customer_name:order.customer_name,customer_tier:order.customer_tier||'Standard',status:order.status,priority:order.priority||'Medium',assigned_warehouse_code:order.assigned_warehouse_id?(get('SELECT code FROM warehouses WHERE id=?',order.assigned_warehouse_id)?.code||'Unassigned'):'Unassigned',delivery_deadline:order.delivery_deadline,hours_to_deadline:hours===null?null:Math.round(hours*10)/10,total_amount:Number(order.total_value||0),total_value:Number(order.total_value||0),affected_quantity:affectedQuantity,items:itemDetails};
 });
 const shortageMetrics={};
 for(const sku of affectedSkus){const demand=Number(totalSkuDemand[sku]||0),avail=Number(inventoryBalances[sku]?.available_quantity||0),onTime=incomingSupply.filter(x=>x.sku===sku&&['In Transit','Scheduled'].includes(x.status)).reduce((sum,x)=>sum+Number(x.quantity||0),0),delayed=incomingSupply.filter(x=>x.sku===sku&&x.status==='Delayed').reduce((sum,x)=>sum+Number(x.quantity||0),0);const confirmed=Math.max(0,demand-avail-onTime),potential=delayed>0&&demand>avail?Math.min(demand-avail,delayed):0;
  shortageMetrics[sku]={total_demand:demand,available_inventory:avail,on_time_inbound:onTime,delayed_inbound:delayed,confirmed_shortage:confirmed,potential_shortage:potential,is_confirmed_deficit:confirmed>0,is_potential_deficit:potential>0&&confirmed===0};
 }
 const assessed=scoreAndRankAllAffectedOrders({disruptionId:d.id});
 const totalValue=ordersAffected.reduce((sum,x)=>sum+Number(x.total_amount||0),0);
 let narrative;
 if(d.shortage_category==='Confirmed Shortage')narrative=`Confirmed Stockout at ${warehouse?.code||'destination hub'}: Customer demand for ${affectedSkus.join(', ')||'specified cargo'} exceeds current available inventory with zero on-time inbound replenishment. ${ordersAffected.length} customer orders require immediate mitigation.`;
 else if(d.shortage_category==='Potential Shortage')narrative=`Potential Transit Shortage: Inbound cargo for ${affectedSkus.join(', ')||'specified cargo'} is delayed by +${Number(d.estimated_delay_hours||0)}h en route to ${warehouse?.code||'destination hub'}. ${ordersAffected.length} customer orders face delivery deadline exposure.`;
 else narrative=`Operational Disruption at ${d.location||'network node'}: Affecting ${ordersAffected.length} customer orders and incoming logistics flow.`;
 return{
  disruption,shipment,supplier,
  warehouse:warehouse?{id:warehouse.id,code:warehouse.code,name:warehouse.name,location:warehouse.location,capacity_sqm:warehouse.capacity_sqm,current_utilization:warehouse.current_utilization}:null,
  affected_skus:affectedSkus,inventory_balances:inventoryBalances,incoming_supply:incomingSupply,alternative_warehouses:alternativeWarehouses,shortage_metrics:shortageMetrics,
  orders_affected:ordersAffected,affected_orders:ordersAffected.map(x=>({order_id:x.id,order_number:x.order_number,customer_name:x.customer_name,customer_tier:x.customer_tier,priority:x.priority,status:x.status,total_value:x.total_value,delivery_deadline:x.delivery_deadline})),
  total_affected_orders_count:ordersAffected.length,affected_order_count:ordersAffected.length,total_affected_order_value:totalValue,
  risk_assessments:assessed,narrative_explanation:narrative,analyzed_at:now.toISOString()
 };
}
function analyzeAllActiveDisruptions(){return all("SELECT id FROM disruptions WHERE status IN ('Active','Investigating') ORDER BY detected_at DESC").map(d=>analyzeDisruptionImpact(d.id));}
module.exports={analyzeDisruptionImpact,analyzeAllActiveDisruptions};
