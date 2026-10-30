'use strict';
const { get, all } = require('../database');
const CONFIG={version:'1.0-deterministic',weights:{deadline_risk:.35,shortage_risk:.30,customer_priority:.20,recovery_difficulty:.15},priority_scores:{Critical:90,High:70,Medium:40,Normal:40,Low:15},tier_modifiers:{Platinum:10,Gold:5,Silver:2,Standard:0}};
const round=(n,d=2)=>{const f=10**d;return Math.round((Number(n)+Number.EPSILON)*f)/f;};
const clamp=(n,a=0,b=100)=>Math.min(b,Math.max(a,n));
const classifySeverity=s=>s>=80?'Critical':s>=60?'High':s>=30?'Medium':'Low';
const isoHours=(date,now)=>date?(new Date(date).getTime()-now.getTime())/3600000:null;
function getInventory(warehouseId,sku,cache=null){
  if(!warehouseId)return null;const key=`${warehouseId}:${sku}`;
  if(cache?.inventory?.has(key))return cache.inventory.get(key);
  const row=get('SELECT i.*,w.code AS warehouse_code,w.location AS warehouse_location FROM inventories i JOIN warehouses w ON w.id=i.warehouse_id WHERE i.warehouse_id=? AND i.sku=?',warehouseId,sku);
  if(cache?.inventory)cache.inventory.set(key,row);return row;
}
function getOrderRecord(id,cache=null){
  if(cache?.orders?.has(id))return cache.orders.get(id);
  const order=get('SELECT o.*,w.code AS warehouse_code,w.location AS warehouse_location FROM customer_orders o LEFT JOIN warehouses w ON w.id=o.assigned_warehouse_id WHERE o.id=?',id);
  if(order)order.items=all('SELECT * FROM order_items WHERE order_id=? ORDER BY id',id);
  if(cache?.orders)cache.orders.set(id,order);return order;
}
function getDisruptionRecord(id,cache=null){
  if(cache?.disruptions?.has(id))return cache.disruptions.get(id);
  const d=get('SELECT d.*,w.code AS warehouse_code,w.location AS warehouse_location,s.tracking_number,s.supplier_id,s.destination_warehouse_id AS ship_destination_id,s.origin_city,s.destination_city,s.carrier,s.estimated_arrival FROM disruptions d LEFT JOIN warehouses w ON w.id=d.warehouse_id LEFT JOIN shipments s ON s.id=d.shipment_id WHERE d.id=?',id);
  if(d){d.shipmentItems=d.shipment_id?all('SELECT * FROM shipment_items WHERE shipment_id=?',d.shipment_id):[];d.supplier=d.supplier_id?get('SELECT * FROM suppliers WHERE id=?',d.supplier_id):null;}
  if(cache?.disruptions)cache.disruptions.set(id,d);return d;
}
function calcDeadline(order,disruption,now){
  const delay=Number(disruption.estimated_delay_hours||0),hours=isoHours(order.delivery_deadline,now);
  if(hours===null)return{score:50,evidence:'Missing promised delivery deadline; baseline 50.0 uncertainty penalty applied.',hours_until_deadline:null,estimated_delay_hours:delay,is_overdue:false,will_miss_deadline:false};
  if(hours<=0)return{score:100,evidence:`Delivery deadline passed ${Math.abs(hours).toFixed(1)}h ago. Order is actively overdue.`,hours_until_deadline:round(hours,1),estimated_delay_hours:delay,is_overdue:true,will_miss_deadline:true};
  if(delay>=hours){const gap=delay-hours;const score=Math.min(100,85+15*(gap/Math.max(24,delay)));return{score:round(score),evidence:`Disruption delay (${delay}h) exceeds remaining delivery window (${hours.toFixed(1)}h) by ${gap.toFixed(1)}h. SLA breach is imminent.`,hours_until_deadline:round(hours,1),estimated_delay_hours:delay,is_overdue:false,will_miss_deadline:true};}
  const buffer=hours-delay;let score,evidence;
  if(buffer<24){score=65+15*(1-buffer/24);evidence=`Tight delivery buffer (${buffer.toFixed(1)}h remaining after ${delay}h delay). High risk of subsequent fulfillment delay causing SLA breach.`;}
  else if(buffer<72){score=35+30*(1-((buffer-24)/48));evidence=`Moderate delivery buffer (${buffer.toFixed(1)}h remaining after ${delay}h delay). Order can absorb minor secondary schedule adjustments.`;}
  else{score=Math.max(5,35*(1-Math.min(1,(buffer-72)/120)));evidence=`Ample delivery buffer (${buffer.toFixed(1)}h remaining after ${delay}h delay). Low probability of missed deadline.`;}
  return{score:round(score),evidence,hours_until_deadline:round(hours,1),estimated_delay_hours:delay,is_overdue:false,will_miss_deadline:false};
}
function calcShortage(order,disruption,affectedSkus,cache=null){
  const targetWh=order.assigned_warehouse_id||disruption.warehouse_id||disruption.ship_destination_id;
  let matching=order.items.filter(x=>!affectedSkus.length||affectedSkus.includes(x.sku));if(!matching.length)matching=order.items;
  const total=matching.reduce((s,x)=>s+Number(x.quantity||0),0),sku=matching[0]?.sku||'Unknown';
  if(!targetWh)return{score:60,evidence:'Unassigned fulfillment warehouse. Inventory availability cannot be confirmed.',primary_sku:sku,order_quantity:total,available_quantity:0,shortage_quantity:total,is_confirmed_shortage:false};
  const inv=getInventory(targetWh,sku,cache),available=inv?Math.max(0,inv.quantity-inv.reserved_quantity):0,onHand=inv?.quantity||0,reserved=inv?.reserved_quantity||0,reorder=inv?.reorder_point||0;
  let score,shortage=0,confirmed=false,evidence;
  if(!inv||available<=0){shortage=total;score=100;confirmed=true;evidence=`Zero available stock for ${sku} at destination warehouse (Total on-hand: ${onHand}, Reserved: ${reserved}). Deficit: ${shortage} units.`;}
  else if(total>available){shortage=total-available;score=Math.min(100,70+30*(shortage/Math.max(1,total)));confirmed=true;evidence=`Insufficient available stock (${available} available vs ${total} required). Immediate shortfall of ${shortage} units for ${sku}.`;}
  else{
    const demandKey=`${targetWh}:${sku}`;let demand;
    if(cache?.demand?.has(demandKey))demand=cache.demand.get(demandKey);
    else{demand=Number(get(`SELECT COALESCE(SUM(oi.quantity),0) AS n FROM order_items oi JOIN customer_orders o ON o.id=oi.order_id WHERE oi.sku=? AND o.assigned_warehouse_id=? AND o.status IN ('Pending','Allocated','At Risk')`,sku,targetWh).n||0);if(cache?.demand)cache.demand.set(demandKey,demand);}
    if(demand>available){const deficit=demand-available;score=35+25*Math.min(1,deficit/Math.max(1,demand));evidence=`Available stock (${available}) covers this single order (${total}), but total customer demand (${demand}) exceeds available inventory by ${deficit} units.`;}
    else if(available<=reorder){score=25;evidence=`Sufficient stock for order (${total} req / ${available} avail), but inventory is at/below safety threshold (reorder point: ${reorder}).`;}
    else{score=10;evidence=`Healthy available inventory (${available} available vs ${total} required; reorder point: ${reorder}).`;}
  }
  return{score:round(score),evidence,primary_sku:sku,order_quantity:total,available_quantity:available,shortage_quantity:shortage,is_confirmed_shortage:confirmed};
}
function calcPriority(order){const titleCase=value=>String(value||'').toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());const p=titleCase(order.priority||'Medium'),t=titleCase(order.customer_tier||'Standard');const base=CONFIG.priority_scores[p]??40,mod=CONFIG.tier_modifiers[t]??0,score=clamp(base+mod);return{score:round(score),evidence:`Order Priority '${p}' (Base: ${base.toFixed(1)}) + Customer Tier '${t}' (+${mod.toFixed(1)}) = ${score.toFixed(1)}/100.`,priority:p,customer_tier:t,base_score:base,tier_modifier:mod};}
function calcRecovery(order,disruption,sku,required,now,cache=null){
  const target=order.assigned_warehouse_id||disruption.warehouse_id;const hours=isoHours(order.delivery_deadline,now)??72;
  const altKey=`${target||-1}:${sku}`;let alts;
  if(cache?.alternatives?.has(altKey))alts=cache.alternatives.get(altKey);
  else{alts=all(`SELECT i.*,w.code AS warehouse_code FROM inventories i JOIN warehouses w ON w.id=i.warehouse_id WHERE i.warehouse_id<>? AND i.sku=?`,target||-1,sku);if(cache?.alternatives)cache.alternatives.set(altKey,alts);}
  const surplus=alts.reduce((s,x)=>s+Math.max(0,x.quantity-x.reserved_quantity-x.reorder_point),0);const codes=alts.filter(x=>x.quantity-x.reserved_quantity-x.reorder_point>0).map(x=>x.warehouse_code);
  let score,evidence;
  if(surplus>=required&&required>0){if(hours<36){score=50;evidence=`Surplus stock exists in network (${surplus} units across ${codes.join(', ')}), but remaining delivery window (${hours.toFixed(1)}h) makes inter-hub transit tight.`;}else{score=20;evidence=`High mitigation feasibility: Alternative warehouse (${codes.join(', ')}) holds ${surplus} surplus units available for transfer before deadline.`;}}
  else if(surplus>0){score=65;evidence=`Partial network buffer: Alternative warehouses hold ${surplus} surplus units, which cannot fully cover required ${required} units. Split fulfillment or partial stock transfer required.`;}
  else{const lead=Number(disruption.supplier?.lead_time_days||10);if(hours<lead*24){score=95;evidence=`Severe recovery obstacle: Zero network surplus stock for ${sku}. Supplier replenishment lead time (${lead} days) exceeds deadline (${hours.toFixed(1)}h).`;}else{score=75;evidence=`High recovery difficulty: Zero warehouse surplus in network. Emergency supplier reorder required (Supplier lead time: ${lead} days).`;}}
  return{score:round(score),evidence,alternative_surplus_units:surplus,transfer_candidate_warehouses:codes};
}
function calculateOrderRisk(orderId,disruptionId,now=new Date(),cache=null){
  const order=getOrderRecord(orderId,cache),disruption=getDisruptionRecord(disruptionId,cache);if(!order||!disruption)return null;
  const skus=disruption.shipmentItems.map(x=>x.sku);
  const deadline=calcDeadline(order,disruption,now),shortage=calcShortage(order,disruption,skus,cache),priority=calcPriority(order),recovery=calcRecovery(order,disruption,shortage.primary_sku,shortage.order_quantity,now,cache);
  const weights=CONFIG.weights;const contributions={deadline_risk:round(deadline.score*weights.deadline_risk),shortage_risk:round(shortage.score*weights.shortage_risk),customer_priority:round(priority.score*weights.customer_priority),recovery_difficulty:round(recovery.score*weights.recovery_difficulty)};
  const final=round(clamp(contributions.deadline_risk+contributions.shortage_risk+contributions.customer_priority+contributions.recovery_difficulty));
  const severity=classifySeverity(final);
  return{order_id:order.id,order_number:order.order_number,customer_name:order.customer_name,customer_tier:order.customer_tier,order_priority:order.priority,order_status:order.status,delivery_deadline:order.delivery_deadline,delivery_deadline_dt:order.delivery_deadline,disruption_id:disruption.id,disruption_code:disruption.disruption_code,disruption_title:disruption.title,disruption_severity:disruption.severity,affected_sku:shortage.primary_sku,required_quantity:shortage.order_quantity,available_quantity:shortage.available_quantity,shortage_quantity:shortage.shortage_quantity,estimated_delay_hours:disruption.estimated_delay_hours,final_risk_score:final,severity,components:{deadline_risk:{...deadline,weight:weights.deadline_risk,contribution:contributions.deadline_risk},shortage_risk:{...shortage,weight:weights.shortage_risk,contribution:contributions.shortage_risk},customer_priority:{...priority,weight:weights.customer_priority,contribution:contributions.customer_priority},recovery_difficulty:{...recovery,weight:weights.recovery_difficulty,contribution:contributions.recovery_difficulty}},explanation:`Order ${order.order_number} (${order.customer_name}) assessed with ${severity} risk (${final.toFixed(2)}/100). Key drivers: ${deadline.evidence} | ${shortage.evidence}`,calculated_at:now.toISOString()};
}
function scoreAndRankAllAffectedOrders(filters={}){
  const now=new Date(),rows=[];
  const params=[];let filterSql='';
  if(filters.disruptionId){filterSql=' AND d.id=?';params.push(Number(filters.disruptionId));}
  const pairs=all(`SELECT x.customer_order_id,d.id AS disruption_id FROM disruptions d JOIN disruption_affected_orders x ON x.disruption_id=d.id WHERE d.status IN ('Active','Investigating')${filterSql} ORDER BY d.id,x.customer_order_id`,...params);
  const cache={orders:new Map(),disruptions:new Map(),inventory:new Map(),demand:new Map(),alternatives:new Map()};
  const seen=new Set();
  for(const pair of pairs){
    const key=`${pair.customer_order_id}:${pair.disruption_id}`;if(seen.has(key))continue;seen.add(key);
    const scored=calculateOrderRisk(pair.customer_order_id,pair.disruption_id,now,cache);if(scored)rows.push(scored);
  }
  let out=rows;
  if(filters.severity&&filters.severity.toLowerCase()!=='all')out=out.filter(x=>x.severity.toLowerCase()===filters.severity.toLowerCase());
  if(filters.status&&filters.status.toLowerCase()!=='all')out=out.filter(x=>x.order_status.toLowerCase()===filters.status.toLowerCase().replaceAll('_',' '));
  if(filters.priority&&filters.priority.toLowerCase()!=='all')out=out.filter(x=>x.order_priority.toLowerCase()===filters.priority.toLowerCase());
  if(filters.q){const q=filters.q.toLowerCase();out=out.filter(x=>`${x.order_number} ${x.customer_name} ${x.affected_sku}`.toLowerCase().includes(q));}
  out.sort((a,b)=>b.final_risk_score-a.final_risk_score||String(a.delivery_deadline_dt||'9999').localeCompare(String(b.delivery_deadline_dt||'9999'))||a.order_number.localeCompare(b.order_number));
  return out.map((x,i)=>({...x,rank:i+1}));
}
module.exports={CONFIG,classifySeverity,calculateOrderRisk,scoreAndRankAllAffectedOrders,calcDeadline,calcShortage,calcPriority,calcRecovery};
