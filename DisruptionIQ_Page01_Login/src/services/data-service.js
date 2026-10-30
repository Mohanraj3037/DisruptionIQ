'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {get,all}=require('../database');
const {scoreAndRankAllAffectedOrders}=require('../domain/risk-engine');
const DEMO=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../data/demo-data.json'),'utf8'));
const round=n=>Math.round(Number(n)||0);
const ACTIVE_DISRUPTION="('Active','Investigating')";
const isoDay=d=>d.toISOString().slice(0,10);
function ageLabel(date){
 if(!date)return '—';
 const time=new Date(date).getTime();if(!Number.isFinite(time))return '—';
 const mins=Math.max(0,Math.floor((Date.now()-time)/60000));
 if(mins<60)return `${mins} min ago`;
 if(mins<1440)return `${Math.floor(mins/60)} hr ago`;
 return `${Math.floor(mins/1440)} days ago`;
}
function formatEta(row){
 if(row.eta_label)return row.eta_label;
 if(!row.estimated_arrival)return '—';
 const date=new Date(row.estimated_arrival);
 return Number.isNaN(date.getTime())?'—':date.toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'UTC'});
}
function trendFromDatabase(days=7){
 const count=Math.max(1,Math.min(30,Number(days)||7));
 const start=new Date();start.setUTCHours(0,0,0,0);start.setUTCDate(start.getUTCDate()-(count-1));
 const detected=all(`SELECT date(detected_at) AS day,COUNT(*) AS total FROM disruptions WHERE date(detected_at)>=date(?) GROUP BY date(detected_at)`,isoDay(start));
 const resolved=all(`SELECT date(resolved_at) AS day,COUNT(*) AS total FROM disruptions WHERE resolved_at IS NOT NULL AND date(resolved_at)>=date(?) GROUP BY date(resolved_at)`,isoDay(start));
 const dMap=new Map(detected.map(x=>[x.day,Number(x.total)])),rMap=new Map(resolved.map(x=>[x.day,Number(x.total)]));
 const labels=[],a=[],b=[];
 for(let i=0;i<count;i++){const d=new Date(start);d.setUTCDate(start.getUTCDate()+i);const key=isoDay(d);labels.push(d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',timeZone:'UTC'}));a.push(dMap.get(key)||0);b.push(rMap.get(key)||0);}
 return{labels,detected:a,resolved:b};
}
function riskExplanation(row){const deadline=row.components?.deadline_risk?.evidence||'';const shortage=row.components?.shortage_risk?.evidence||'';return `${row.severity} risk (${Number(row.final_risk_score||0)}/100). ${deadline} ${shortage}`.trim();}
function calculateRiskOverview(){
 const assessments=scoreAndRankAllAffectedOrders();
 const byOrder=new Map();
 for(const row of assessments){
  const prev=byOrder.get(row.order_id);
  if(!prev||Number(row.final_risk_score)>Number(prev.final_risk_score))byOrder.set(row.order_id,row);
 }
 const orders=[...byOrder.values()].sort((a,b)=>b.final_risk_score-a.final_risk_score);
 const distribution={Critical:0,High:0,Medium:0,Low:0};
 for(const row of orders)distribution[row.severity]=(distribution[row.severity]||0)+1;
 return{
  total_affected_orders:orders.length,
  critical_risk_orders:distribution.Critical,
  high_risk_orders:distribution.High,
  medium_risk_orders:distribution.Medium,
  low_risk_orders:distribution.Low,
  distribution:Object.entries(distribution).map(([label,value])=>({label,value})),
  critical_orders:orders.filter(x=>x.severity==='Critical').slice(0,10).map(x=>({order_id:x.order_id,order_number:x.order_number,risk_score:x.final_risk_score,risk_level:x.severity,disruption_id:x.disruption_id,explanation:riskExplanation(x)})),
  high_risk_order_records:orders.filter(x=>x.severity==='High').slice(0,10).map(x=>({order_id:x.order_id,order_number:x.order_number,risk_score:x.final_risk_score,risk_level:x.severity,disruption_id:x.disruption_id,explanation:riskExplanation(x)})),
  medium_risk_order_records:orders.filter(x=>x.severity==='Medium').slice(0,10).map(x=>({order_id:x.order_id,order_number:x.order_number,risk_score:x.final_risk_score,risk_level:x.severity,disruption_id:x.disruption_id,explanation:riskExplanation(x)})),
  low_risk_order_records:orders.filter(x=>x.severity==='Low').slice(0,10).map(x=>({order_id:x.order_id,order_number:x.order_number,risk_score:x.final_risk_score,risk_level:x.severity,disruption_id:x.disruption_id,explanation:riskExplanation(x)})),
  assessments_count:assessments.length,
  average_risk_score:orders.length?round(orders.reduce((sum,x)=>sum+Number(x.final_risk_score||0),0)/orders.length):0,
  order_records:orders,
  scoring_method:'Deterministic backend risk engine; one highest current score per affected order.'
 };
}
function buildDashboardSections(trendDays=7){
 const shipmentRows=all(`SELECT s.*,w.name AS destination_hub_name,
   EXISTS(SELECT 1 FROM disruptions d WHERE d.shipment_id=s.id AND d.status IN ${ACTIVE_DISRUPTION}) AS has_active_disruption
   FROM shipments s LEFT JOIN warehouses w ON w.id=s.destination_warehouse_id ORDER BY COALESCE(s.estimated_arrival,s.created_at) DESC,s.id DESC`);
 const shipments=shipmentRows.map(s=>{
  let status;
  if(s.status==='Delivered')status='Delivered';
  else if(s.status==='Delayed')status='Delayed';
  else if(Number(s.has_active_disruption))status='Disrupted';
  else if(String(s.ui_status||'').toLowerCase()==='at risk'||Number(s.risk_score)>=60)status='At Risk';
  else if(s.status==='In Transit')status='In Transit';
  else status='Scheduled';
  return{id:s.id,tracking_number:s.tracking_number,status,raw_status:s.status,ui_status:s.ui_status||null,risk_score:Number(s.risk_score||0),destination_hub_name:s.destination_hub_name||null,data_origin:s.data_origin||'operational'};
 });
 const totalShipments=shipmentRows.length;
 const inTransit=shipmentRows.filter(s=>s.status==='In Transit').length;
 const delivered=shipmentRows.filter(s=>s.status==='Delivered').length;
 const delayed=shipmentRows.filter(s=>s.status==='Delayed').length;
 const shipmentCounts=['In Transit','Delivered','Delayed','At Risk','Disrupted','Scheduled'].map(label=>({label,value:shipments.filter(s=>s.status===label).length}));
 const shipmentHealth={total:totalShipments,distribution:shipmentCounts,labels:shipmentCounts.map(x=>x.label),values:shipmentCounts.map(x=>x.value)};
 const activeDisruptions=all(`SELECT d.id,d.disruption_code,d.title,d.disruption_type,d.source_entity_type,d.source_entity_id,d.severity,d.status,d.detected_at,d.description,d.shipment_id,d.warehouse_id,d.data_origin,
   s.tracking_number,w.name AS hub_name,w.code AS hub_code,
   (SELECT COUNT(DISTINCT x.customer_order_id) FROM disruption_affected_orders x WHERE x.disruption_id=d.id) AS affected_orders
   FROM disruptions d LEFT JOIN shipments s ON s.id=d.shipment_id LEFT JOIN warehouses w ON w.id=COALESCE(d.warehouse_id,s.destination_warehouse_id)
   WHERE d.status IN ${ACTIVE_DISRUPTION} ORDER BY d.detected_at DESC`);
 const activeCount=activeDisruptions.length;
 const severityDistribution=['Critical','High','Medium','Low'].map(label=>({label,value:activeDisruptions.filter(x=>String(x.severity).toLowerCase()===label.toLowerCase()).length}));
 const typeMap=new Map();for(const d of activeDisruptions){const key=d.disruption_type||'Other';typeMap.set(key,(typeMap.get(key)||0)+1);}
 const typeDistribution=[...typeMap].map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value);
 const affectedOrders=Number(get(`SELECT COUNT(DISTINCT x.customer_order_id) AS n FROM disruption_affected_orders x JOIN disruptions d ON d.id=x.disruption_id WHERE d.status IN ${ACTIVE_DISRUPTION}`).n||0);
 const affectedShipments=Number(get(`SELECT COUNT(DISTINCT d.shipment_id) AS n FROM disruptions d WHERE d.status IN ${ACTIVE_DISRUPTION} AND d.shipment_id IS NOT NULL`).n||0);
 const risk=calculateRiskOverview();
 const plans=all(`SELECT p.*,d.disruption_code,d.warehouse_id AS disruption_warehouse_id,
   COALESCE(w.name,wh.name) AS hub_name,u.full_name AS creator_name
   FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id AND p.data_origin='operational'
   LEFT JOIN warehouses w ON w.id=d.warehouse_id
   LEFT JOIN shipments s ON s.id=d.shipment_id LEFT JOIN warehouses wh ON wh.id=s.destination_warehouse_id
   LEFT JOIN users u ON u.id=p.created_by_id ORDER BY p.created_at DESC`);
 const actions=all(`SELECT a.*,p.plan_code,p.customer_order_id,p.status AS plan_status,d.warehouse_id,s.destination_warehouse_id
   FROM recovery_actions a JOIN recovery_plans p ON p.id=a.recovery_plan_id AND p.data_origin='operational'
   JOIN disruptions d ON d.id=p.disruption_id LEFT JOIN shipments s ON s.id=d.shipment_id`);
 const pendingApprovals=Number(get("SELECT COUNT(DISTINCT recovery_plan_id) AS n FROM approvals WHERE status='Pending' AND data_origin='operational'").n||0);
 const recoveryOverview={
  awaiting_approval:plans.filter(p=>p.status==='Pending Approval').length,
  approved_plans:plans.filter(p=>p.status==='Approved').length,
  actions_in_progress:actions.filter(a=>['In Progress','Executing'].includes(a.status)).length,
  completed_actions:actions.filter(a=>a.status==='Completed').length,
  failed_or_blocked_actions:actions.filter(a=>['Failed','Blocked'].includes(a.status)).length,
  plans_in_progress:plans.filter(p=>['Approved','Execution Ready','Executing'].includes(p.status)).length,
  pending_approvals:pendingApprovals,
  successfully_recovered_orders:Number(get("SELECT COUNT(DISTINCT customer_order_id) AS n FROM recovery_plans WHERE data_origin='operational' AND status='Executed' AND customer_order_id IS NOT NULL AND execution_result_json IS NOT NULL").n||0),
  total_plans:plans.length,total_actions:actions.length,
  mitigation_coverage_percent:affectedOrders?round(Number(get(`SELECT COUNT(DISTINCT p.customer_order_id) AS n FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id WHERE p.data_origin='operational' AND d.status IN ${ACTIVE_DISRUPTION} AND p.customer_order_id IS NOT NULL AND p.status IN ('Pending Approval','Approved','Execution Ready','Executed')`).n||0)/affectedOrders*100):0
 };
 const hubs=all(`SELECT w.id,w.code,w.name,w.location,
   COUNT(DISTINCT s.id) AS shipment_count,
   COUNT(DISTINCT CASE WHEN s.status='Delayed' THEN s.id END) AS delayed_shipments,
   COUNT(DISTINCT CASE WHEN d.status IN ${ACTIVE_DISRUPTION} THEN d.id END) AS active_disruptions,
   COUNT(DISTINCT CASE WHEN d.status IN ${ACTIVE_DISRUPTION} THEN x.customer_order_id END) AS affected_orders,
   COUNT(DISTINCT CASE WHEN a.status='Completed' THEN a.id END) AS completed_recovery_actions,
   COUNT(DISTINCT a.id) AS recovery_actions
   FROM warehouses w
   LEFT JOIN shipments s ON s.destination_warehouse_id=w.id
   LEFT JOIN disruptions d ON (d.warehouse_id=w.id OR d.shipment_id=s.id)
   LEFT JOIN disruption_affected_orders x ON x.disruption_id=d.id
   LEFT JOIN recovery_plans p ON p.disruption_id=d.id AND p.data_origin='operational'
   LEFT JOIN recovery_actions a ON a.recovery_plan_id=p.id
   GROUP BY w.id,w.code,w.name,w.location ORDER BY shipment_count DESC,w.code`);
 const audit=all(`SELECT a.id,a.action,a.entity_type,a.entity_id,a.details,a.timestamp,a.data_origin,
   u.full_name,u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.data_origin='operational' ORDER BY a.timestamp DESC,a.id DESC LIMIT 30`);
 const recentActivities=audit.map(a=>{
  const action=String(a.action||'').toUpperCase();
  let status=null;
  if(action.includes('APPROVE'))status='Approved';
  else if(action.includes('REJECT'))status='Rejected';
  else if(action.includes('EXECUTE'))status='Completed';
  else if(action.includes('SUBMIT')||action.includes('REQUEST'))status='Pending';
  else if(action.includes('FAIL')||action.includes('BLOCK'))status='Failed';
  return{id:a.id,type:a.action,description:a.details||`${a.action} · ${a.entity_type} ${a.entity_id||''}`.trim(),timestamp:a.timestamp,entity_type:a.entity_type,entity_id:a.entity_id||null,status,actor:a.full_name||a.username||'System',is_synthetic:a.data_origin==='synthetic'};
 });
 const notificationActivities=all(`SELECT id,title,message,category,is_read,created_at,data_origin FROM notifications WHERE data_origin='operational' ORDER BY created_at DESC,id DESC LIMIT 15`)
  .map(n=>({id:`notification-${n.id}`,type:'CUSTOMER_NOTIFICATION',description:`${n.title}: ${n.message}`,timestamp:n.created_at,
    entity_type:'Notification',entity_id:String(n.id),status:Number(n.is_read)?'Read':'Unread',actor:'System',is_synthetic:n.data_origin==='synthetic'}));
 const webhookActivities=all(`SELECT id,source,event_type,processing_status,received_at,payload_json,data_origin FROM webhook_events WHERE data_origin='operational' ORDER BY received_at DESC,id DESC LIMIT 15`)
  .map(e=>{let payload={};try{payload=JSON.parse(e.payload_json||'{}');}catch{}
   return{id:`webhook-${e.id}`,type:'CARRIER_WEBHOOK_EVENT',description:`${e.event_type} received from ${e.source||'carrier'} for shipment ${payload.shipment_id||'unknown'}`,
    timestamp:e.received_at,entity_type:'Shipment',entity_id:payload.shipment_id||null,status:e.processing_status,actor:e.source||'Carrier integration',is_synthetic:e.data_origin==='synthetic'};});
 const shipmentMovements=all(`SELECT id,tracking_number,status,origin_city,destination_city,carrier,created_at,risk_score
   FROM shipments WHERE created_at IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 15`)
  .map(s=>({id:`shipment-${s.id}`,type:'SHIPMENT_REGISTERED',description:`${s.tracking_number} · ${s.origin_city||'Origin not recorded'} → ${s.destination_city||'Destination not recorded'} · ${s.status} · risk ${round(s.risk_score)}/100`,timestamp:s.created_at,entity_type:'Shipment',entity_id:String(s.id),status:s.status,actor:s.carrier||'Carrier record'}));
 const activityFeed=[...recentActivities,...notificationActivities,...webhookActivities,...shipmentMovements]
  .sort((a,b)=>new Date(b.timestamp).getTime()-new Date(a.timestamp).getTime()).slice(0,20);
 const recentDisruptions=activeDisruptions.slice(0,10).map(d=>({
  id:d.id,code:d.disruption_code,title:d.title,type:d.disruption_type,source_entity_type:d.source_entity_type||null,source_entity_id:d.source_entity_id||null,severity:d.severity,status:d.status,
  detected_at:d.detected_at,description:d.description,shipment_id:d.shipment_id,tracking_number:d.tracking_number||null,
  hub_name:d.hub_name||null,hub_code:d.hub_code||null,affected_orders:Number(d.affected_orders||0),is_synthetic:d.data_origin==='synthetic'
 }));
 const supplierGroups=all(`SELECT COALESCE(NULLIF(region,''),NULLIF(state,''),NULLIF(country,''),'Unspecified') AS region,
   AVG(CASE WHEN risk_score>0 THEN risk_score ELSE (1-COALESCE(reliability_score,1))*100 END) AS exposure,
   COUNT(*) AS suppliers FROM suppliers GROUP BY COALESCE(NULLIF(region,''),NULLIF(state,''),NULLIF(country,''),'Unspecified') ORDER BY exposure DESC`);
 const regionalExposure={labels:supplierGroups.map(x=>x.region),values:supplierGroups.map(x=>round(x.exposure)),suppliers:supplierGroups.map(x=>Number(x.suppliers))};
 const averageRisk=risk.average_risk_score;
 const totalUnits=Number(get('SELECT COALESCE(SUM(unit_count),0) AS n FROM shipments').n||0);
 const recoveryValue=Number(get("SELECT COALESCE(SUM(protected_value),0) AS n FROM recovery_plans WHERE data_origin='operational' AND status NOT IN ('Rejected','Cancelled','Execution Failed')").n||0);
 const inventory=all('SELECT quantity,reserved_quantity,reorder_point FROM inventories');
 const inventoryCoverage=inventory.length?round(inventory.filter(x=>Math.max(0,x.quantity-x.reserved_quantity)>x.reorder_point).length/inventory.length*100):0;
 const originCounts=all(`SELECT data_origin,SUM(n) AS n FROM (
  SELECT data_origin,COUNT(*) AS n FROM suppliers GROUP BY data_origin
  UNION ALL SELECT data_origin,COUNT(*) AS n FROM warehouses GROUP BY data_origin
  UNION ALL SELECT data_origin,COUNT(*) AS n FROM inventories GROUP BY data_origin
  UNION ALL SELECT data_origin,COUNT(*) AS n FROM shipments GROUP BY data_origin
  UNION ALL SELECT data_origin,COUNT(*) AS n FROM customer_orders GROUP BY data_origin
  UNION ALL SELECT data_origin,COUNT(*) AS n FROM disruptions GROUP BY data_origin
  UNION ALL SELECT data_origin,COUNT(*) AS n FROM recovery_plans GROUP BY data_origin
  UNION ALL SELECT data_origin,COUNT(*) AS n FROM approvals GROUP BY data_origin
  UNION ALL SELECT data_origin,COUNT(*) AS n FROM recovery_actions GROUP BY data_origin
  UNION ALL SELECT data_origin,COUNT(*) AS n FROM webhook_events GROUP BY data_origin
 ) GROUP BY data_origin`);
 const hasSynthetic=originCounts.some(x=>x.data_origin==='synthetic'&&x.n>0);
 const hasOperational=originCounts.some(x=>x.data_origin!=='synthetic'&&x.n>0);
 const summary={
  total_shipments:totalShipments,in_transit_shipments:inTransit,delivered_shipments:delivered,delayed_shipments:delayed,
  active_disruptions:activeCount,affected_customer_orders:affectedOrders,
  high_risk_orders:risk.critical_risk_orders+risk.high_risk_orders,
  recovery_plans_in_progress:recoveryOverview.plans_in_progress,pending_approvals:pendingApprovals,
  successfully_recovered_orders:recoveryOverview.successfully_recovered_orders
 };
 const atRiskShipments=shipments.filter(s=>['At Risk','Disrupted','Delayed'].includes(s.status)).length;
 const overview={
  networkExposure:averageRisk,totalUnits,atRiskShipments,recoveryValue,
  activeIncidents:activeCount,criticalIncidents:severityDistribution.find(x=>x.label==='Critical')?.value||0,
  monitoredSuppliers:Number(get('SELECT COUNT(*) AS n FROM suppliers').n||0),inventoryCoverage,
  disruptionTrend:trendFromDatabase(trendDays),regionalExposure,shipmentStatus:{labels:['On schedule','At risk','Delayed'],values:[shipmentRows.filter(s=>s.status!=='Delayed'&&String(s.ui_status||'').toLowerCase()!=='at risk'&&!Number(s.has_active_disruption)).length,shipmentRows.filter(s=>s.status!=='Delayed'&&(String(s.ui_status||'').toLowerCase()==='at risk'||Number(s.has_active_disruption))).length,delayed]},
  networkNodes:[],networkEdges:[]
 };
 const riskQueue=risk.order_records.slice(0,12).map(x=>({id:x.order_number,order_id:x.order_id,risk:x.final_risk_score,severity:x.severity,explanation:riskExplanation(x)}));
 delete risk.order_records;
 const shipmentList=shipmentRows.map(s=>({
  id:s.tracking_number,route:`${s.origin_city||'Unknown'} → ${s.destination_city||'Unknown'}`,carrier:s.carrier||'Unassigned carrier',
  eta:formatEta(s),status:s.status==='Delayed'?'Delayed':(String(s.ui_status||'').toLowerCase()==='at risk'||Number(s.has_active_disruption))?'At risk':'On schedule',
  operationalStatus:s.status==='Delivered'?'Delivered':s.status==='Delayed'?'Delayed':Number(s.has_active_disruption)?'Disrupted':String(s.ui_status||'').toLowerCase()==='at risk'?'At Risk':s.status==='In Transit'?'In Transit':'Scheduled',
  risk:round(s.risk_score),progress:round(s.progress),units:round(s.unit_count),isSynthetic:s.data_origin==='synthetic'
 }));
 const incidents=all(`SELECT * FROM disruptions ORDER BY CASE severity WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,detected_at DESC`).map(i=>({
  id:i.disruption_code,backendId:i.id,severity:i.severity,title:i.title,route:i.ui_route||i.location||'Network event',
  impact:i.ui_impact||i.description||'Operational review required',age:i.ui_age||ageLabel(i.detected_at),
  status:['Resolved','Mitigated'].includes(i.status)?'Acknowledged':i.status,owner:i.ui_owner||'Hub operations',
  isSynthetic:i.data_origin==='synthetic'
 }));
 const suppliers=all('SELECT * FROM suppliers ORDER BY risk_score DESC').map(s=>({
  name:s.name,region:s.region||s.state||s.country||'Unspecified',risk:round(s.risk_score>0?s.risk_score:(1-Number(s.reliability_score||1))*100),
  reliability:round(Number(s.reliability_score||0)*100),exposure:s.exposure||'Supplier reliability'
 }));
 const recoveryPlans=plans.map(p=>({
  id:p.plan_code,title:p.title,priority:p.priority||'Medium',
  status:({Draft:'Planned','Changes Requested':'Planned','Pending Approval':'Awaiting approval',Approved:'In progress','Execution Ready':'In progress',Executed:'Completed',Rejected:'Planned',Cancelled:'Completed','Execution Failed':'Planned'}[p.status]||p.status),
  owner:p.creator_name||'Hub operations',due:p.due_label||'—',value:round(p.protected_value||0),progress:round(p.progress||0),backendStatus:p.status,backendId:p.id,isSynthetic:p.data_origin==='synthetic'
 }));
 const approvals=all(`SELECT a.*,p.plan_code,p.title AS plan_title,p.protected_value,u.full_name AS requester_name
  FROM approvals a JOIN recovery_plans p ON p.id=a.recovery_plan_id JOIN users u ON u.id=a.requester_id WHERE a.data_origin='operational' ORDER BY a.requested_at DESC`)
  .map(a=>({id:`APR-${a.id}`,title:a.plan_title,detail:`${a.plan_code} · ${a.required_role}`,requestedBy:a.requester_name,time:ageLabel(a.requested_at),
    impact:`₹${round(a.protected_value).toLocaleString('en-IN')} protected value`,status:a.status,backendId:a.id,planId:a.recovery_plan_id,requiredRole:a.required_role,isSynthetic:a.data_origin==='synthetic'}));
 const auditTrail=audit.map(a=>({time:new Date(a.timestamp).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'}),actor:a.full_name||a.username||'System',action:a.action,target:a.details||`${a.entity_type} ${a.entity_id||''}`.trim(),kind:a.entity_type,isSynthetic:a.data_origin==='synthetic'}));
 return{
  environment:'DisruptionIQ operational workspace',
  workspace:DEMO.workspace,updatedAt:new Date().toISOString(),overview,summary,shipment_health:shipmentHealth,
  disruption_overview:{active_count:activeCount,severity_distribution:severityDistribution,type_distribution:typeDistribution,
   affected_shipments:affectedShipments,affected_orders:affectedOrders,recent_disruptions:recentDisruptions},
  order_risk:risk,recovery_overview:recoveryOverview,hub_performance:hubs.map(h=>({
   id:h.id,code:h.code,name:h.name,location:h.location,shipment_count:Number(h.shipment_count||0),
   delayed_shipments:Number(h.delayed_shipments||0),active_disruptions:Number(h.active_disruptions||0),
   affected_orders:Number(h.affected_orders||0),completed_recovery_actions:Number(h.completed_recovery_actions||0),
   recovery_actions:Number(h.recovery_actions||0),
   recovery_progress:Number(h.recovery_actions||0)?round(Number(h.completed_recovery_actions||0)/Number(h.recovery_actions||0)*100):0
  })),
  recent_activities:activityFeed,last_updated:new Date().toISOString(),
  risk_queue:riskQueue,incidents,shipments:shipmentList,suppliers,recoveryPlans,approvals,auditTrail
 };
}
function getDashboardData(user=null,options={}){
 const data=buildDashboardSections(options.days||7);
 const role=user?.role;const canSeeInternal=role===undefined||['HUB_INCHARGE','RISK_ANALYST','RECOVERY_MANAGER'].includes(role);
 if(!canSeeInternal)return{success:false,error:'Forbidden'};
 return data;
}
function getDashboardSummary(user=null){
 const d=getDashboardData(user);
 return{...d.overview,summary:d.summary,openDisruptions:d.disruption_overview.active_count,pendingApprovals:d.summary.pending_approvals};
}
module.exports={getDashboardData,getDashboardSummary,buildDashboardSections};
