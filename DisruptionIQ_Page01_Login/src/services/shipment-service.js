'use strict';
const {all,get}=require('../database');
const ACTIVE="('Active','Investigating')";
const n=v=>Number(v||0);
const STATUS_VALUES=()=>all('SELECT DISTINCT status FROM shipments ORDER BY status').map(x=>x.status).filter(Boolean);
function shipmentOverview(){
 const counts=get(`SELECT COUNT(*) total,
  SUM(CASE WHEN status='In Transit' THEN 1 ELSE 0 END) in_transit,
  SUM(CASE WHEN status='Delivered' THEN 1 ELSE 0 END) delivered,
  SUM(CASE WHEN status='Delayed' THEN 1 ELSE 0 END) delayed,
  SUM(CASE WHEN status IN ('Pending','Scheduled','Created') THEN 1 ELSE 0 END) pending,
  SUM(CASE WHEN EXISTS(SELECT 1 FROM disruptions d WHERE d.shipment_id=shipments.id AND d.status IN ${ACTIVE}) THEN 1 ELSE 0 END) disruption_affected,
  SUM(CASE WHEN EXISTS(SELECT 1 FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id WHERE d.shipment_id=shipments.id) THEN 1 ELSE 0 END) with_recovery_plans,
  SUM(CASE WHEN EXISTS(SELECT 1 FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id WHERE d.shipment_id=shipments.id AND p.status='Completed' AND p.executed_at IS NOT NULL) THEN 1 ELSE 0 END) successfully_recovered,
  ROUND(COALESCE(AVG(risk_score),0),1) average_risk_score,
  SUM(CASE WHEN risk_score>=60 THEN 1 ELSE 0 END) elevated_risk
  FROM shipments`);
 const status_distribution=all(`SELECT status label,COUNT(*) value FROM shipments GROUP BY status ORDER BY value DESC,label`);
 const carrier_distribution=all(`SELECT COALESCE(NULLIF(TRIM(c.name),''),NULLIF(TRIM(s.carrier),''),'Unassigned') label,
  COUNT(*) value,SUM(CASE WHEN s.status='Delayed' THEN 1 ELSE 0 END) delayed
  FROM shipments s LEFT JOIN carriers c ON c.carrier_code=s.carrier_code
  GROUP BY COALESCE(NULLIF(TRIM(c.name),''),NULLIF(TRIM(s.carrier),''),'Unassigned') ORDER BY value DESC,label LIMIT 10`);
 const route_distribution=all(`SELECT COALESCE(NULLIF(TRIM(s.origin_city),''),NULLIF(TRIM(ow.location),''),'Origin not recorded') origin,
  COALESCE(NULLIF(TRIM(s.destination_city),''),NULLIF(TRIM(dw.location),''),'Destination not recorded') destination,
  COUNT(*) value,SUM(CASE WHEN s.status='Delayed' THEN 1 ELSE 0 END) delayed
  FROM shipments s LEFT JOIN warehouses ow ON ow.id=s.origin_warehouse_id LEFT JOIN warehouses dw ON dw.id=s.destination_warehouse_id
  GROUP BY origin,destination ORDER BY value DESC,origin,destination LIMIT 10`);
 const risk_distribution=all(`SELECT CASE WHEN COALESCE(risk_score,0)>=80 THEN 'Critical'
  WHEN COALESCE(risk_score,0)>=60 THEN 'High' WHEN COALESCE(risk_score,0)>=35 THEN 'Medium' ELSE 'Low' END label,
  COUNT(*) value FROM shipments GROUP BY label ORDER BY CASE label WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END`);
 const transport_distribution=all(`SELECT COALESCE(NULLIF(TRIM(transport_mode),''),'Unspecified') label,COUNT(*) value
  FROM shipments GROUP BY COALESCE(NULLIF(TRIM(transport_mode),''),'Unspecified') ORDER BY value DESC,label`);
 const created_trend=all(`SELECT date(created_at) label,COUNT(*) value FROM shipments
  WHERE created_at IS NOT NULL AND date(created_at) IS NOT NULL
  GROUP BY date(created_at) ORDER BY date(created_at) DESC LIMIT 14`).reverse();
 const destination_distribution=all(`SELECT COALESCE(NULLIF(TRIM(destination_city),''),'Unspecified') label,COUNT(*) value,SUM(CASE WHEN status='Delayed' THEN 1 ELSE 0 END) delayed FROM shipments GROUP BY label ORDER BY value DESC,label LIMIT 10`);
 const mode_delay_distribution=all(`SELECT COALESCE(NULLIF(TRIM(transport_mode),''),'Unspecified') label,COUNT(*) total,SUM(CASE WHEN status='Delayed' THEN 1 ELSE 0 END) delayed,SUM(CASE WHEN status='Delivered' THEN 1 ELSE 0 END) delivered FROM shipments GROUP BY label ORDER BY total DESC,label`);
 const analytics={status_distribution,carrier_distribution,route_distribution,risk_distribution,transport_distribution,created_trend,destination_distribution,mode_delay_distribution};
 return {success:true,summary:Object.fromEntries(Object.entries(counts||{}).map(([k,v])=>[k,n(v)])),statuses:STATUS_VALUES(),analytics,last_updated:new Date().toISOString()};
}
const INDIA_CITY_COORDS={
 chennai:{lat:13.08784,lng:80.27847}, bengaluru:{lat:12.97194,lng:77.59369}, bangalore:{lat:12.97194,lng:77.59369},
 hyderabad:{lat:17.38405,lng:78.45636}, mumbai:{lat:19.07283,lng:72.88261}, pune:{lat:18.51957,lng:73.85535},
 delhi:{lat:28.65195,lng:77.23149}, 'delhi ncr':{lat:28.65195,lng:77.23149}, kolkata:{lat:22.56263,lng:88.36304},
 ahmedabad:{lat:23.02579,lng:72.58727}, coimbatore:{lat:11.00555,lng:76.96612}, jaipur:{lat:26.91962,lng:75.78781},
 kochi:{lat:9.9312,lng:76.2673}, cochin:{lat:9.9312,lng:76.2673}, lucknow:{lat:26.83928,lng:80.92313}, guwahati:{lat:26.1445,lng:91.7362}
};
function cityName(value){
 const raw=String(value||'').split(',')[0].trim();
 const key=raw.toLowerCase().replace(/\s+/g,' ');
 if(['new delhi','nct delhi'].includes(key))return 'Delhi';
 if(key==='bangalore')return 'Bengaluru';
 if(key==='cochin')return 'Kochi';
 const found=Object.keys(INDIA_CITY_COORDS).find(k=>k===key);
 return found?({bangalore:'Bengaluru',cochin:'Kochi','delhi ncr':'Delhi'}[found]||found.replace(/\b\w/g,c=>c.toUpperCase())):null;
}
function shipmentGeography(){
 const raw=all(`SELECT COALESCE(NULLIF(TRIM(s.origin_city),''),NULLIF(TRIM(ow.location),'')) AS origin,
   COALESCE(NULLIF(TRIM(s.destination_city),''),NULLIF(TRIM(dw.location),'')) AS destination,
   COUNT(*) AS shipments,SUM(CASE WHEN s.status='Delayed' THEN 1 ELSE 0 END) AS delayed,
   ROUND(AVG(COALESCE(s.risk_score,0)),1) AS average_risk
   FROM shipments s LEFT JOIN warehouses ow ON ow.id=s.origin_warehouse_id LEFT JOIN warehouses dw ON dw.id=s.destination_warehouse_id
   GROUP BY origin,destination ORDER BY shipments DESC`);
 const nodeMap=new Map();
 const add=(rawCity,direction,row)=>{
   const name=cityName(rawCity);if(!name)return;
   const key=name.toLowerCase(),coord=INDIA_CITY_COORDS[key];if(!coord)return;
   const n=nodeMap.get(key)||{city:name,...coord,shipments:0,outbound:0,inbound:0,delayed:0,warehouse_count:0};
   n.shipments+=Number(row.shipments||0);n[direction]+=Number(row.shipments||0);n.delayed+=Number(row.delayed||0);nodeMap.set(key,n);
 };
 const routes=[];
 for(const row of raw){
   const origin=cityName(row.origin),destination=cityName(row.destination);
   if(!origin||!destination||origin===destination)continue;
   const a=INDIA_CITY_COORDS[origin.toLowerCase()],b=INDIA_CITY_COORDS[destination.toLowerCase()];if(!a||!b)continue;
   add(row.origin,'outbound',row);add(row.destination,'inbound',row);
   routes.push({origin,destination,origin_lat:a.lat,origin_lng:a.lng,destination_lat:b.lat,destination_lng:b.lng,shipments:Number(row.shipments||0),delayed:Number(row.delayed||0),average_risk:Number(row.average_risk||0)});
 }
 const warehouses=all('SELECT location FROM warehouses WHERE is_active=1');
 for(const w of warehouses){const name=cityName(w.location);if(name){const n=nodeMap.get(name.toLowerCase());if(n)n.warehouse_count+=1;}}
 const nodes=[...nodeMap.values()].sort((a,b)=>b.shipments-a.shipments);
 return {success:true,total_shipments:Number(get('SELECT COUNT(*) n FROM shipments')?.n||0),mapped_shipments:routes.reduce((sum,r)=>sum+r.shipments,0),unmapped_shipments:Math.max(0,Number(get('SELECT COUNT(*) n FROM shipments')?.n||0)-routes.reduce((sum,r)=>sum+r.shipments,0)),nodes,routes:routes.slice(0,60),unmapped_route_groups:raw.length-routes.length,location_basis:'City-centre reference coordinates matched to city values in the shipment and warehouse database. Markers are not GPS telemetry.'};
}

function validDate(s){return /^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(`${s}T00:00:00Z`));}
function shipmentList(params={}){
 const page=params.page||1,limit=params.limit||25,offset=(page-1)*limit;
 const where=[],args=[];
 if(params.q){where.push('(CAST(s.id AS TEXT) LIKE ? OR s.tracking_number LIKE ?)');args.push(`%${params.q}%`,`%${params.q}%`);}
 if(params.status){where.push('s.status=?');args.push(params.status);}
 if(params.carrier){where.push('(COALESCE(c.name,s.carrier)=?)');args.push(params.carrier);}
 if(params.origin){where.push('s.origin_warehouse_id=?');args.push(params.origin);}
 if(params.destination){where.push('s.destination_warehouse_id=?');args.push(params.destination);}
 if(params.from){where.push("date(COALESCE(s.actual_departure,s.estimated_departure,s.created_at))>=date(?)");args.push(params.from);}
 if(params.to){where.push("date(COALESCE(s.actual_departure,s.estimated_departure,s.created_at))<=date(?)");args.push(params.to);}
 if(params.disruption==='yes')where.push(`EXISTS(SELECT 1 FROM disruptions dx WHERE dx.shipment_id=s.id AND dx.status IN ${ACTIVE})`);
 if(params.disruption==='no')where.push(`NOT EXISTS(SELECT 1 FROM disruptions dx WHERE dx.shipment_id=s.id AND dx.status IN ${ACTIVE})`);
 const clause=where.length?`WHERE ${where.join(' AND ')}`:'';
 const sortMap={created:'s.created_at',id:'s.id',tracking:'s.tracking_number',status:'s.status',eta:'s.estimated_arrival'};
 const sort=sortMap[params.sort]||'s.created_at',direction=params.direction==='asc'?'ASC':'DESC';
 const total=n(get(`SELECT COUNT(*) n FROM shipments s LEFT JOIN carriers c ON c.carrier_code=s.carrier_code ${clause}`, ...args)?.n);
 const rows=all(`SELECT s.id,s.tracking_number,s.carrier,s.carrier_code,COALESCE(c.name,s.carrier) carrier_name,c.service_type,
  s.status,s.ui_status,s.transport_mode,s.origin_warehouse_id,s.destination_warehouse_id,
  ow.code origin_warehouse_code,ow.name origin_warehouse_name,dw.code destination_warehouse_code,dw.name destination_warehouse_name,
  s.origin_city,s.destination_city,s.estimated_departure,s.actual_departure,s.estimated_arrival,s.actual_arrival,
  s.unit_count,s.risk_score,s.progress,s.data_origin,
  (SELECT COUNT(DISTINCT dx.id) FROM disruptions dx WHERE dx.shipment_id=s.id) disruption_count,
  (SELECT COUNT(DISTINCT x.customer_order_id) FROM disruption_affected_orders x JOIN disruptions dx ON dx.id=x.disruption_id WHERE dx.shipment_id=s.id) affected_order_count
  FROM shipments s LEFT JOIN carriers c ON c.carrier_code=s.carrier_code
  LEFT JOIN warehouses ow ON ow.id=s.origin_warehouse_id LEFT JOIN warehouses dw ON dw.id=s.destination_warehouse_id
  ${clause} ORDER BY ${sort} ${direction},s.id ASC LIMIT ? OFFSET ?`,...args,limit,offset);
 const carriers=all(`SELECT DISTINCT COALESCE(c.name,s.carrier) name FROM shipments s LEFT JOIN carriers c ON c.carrier_code=s.carrier_code WHERE COALESCE(c.name,s.carrier) IS NOT NULL ORDER BY name`);
 const warehouses=all('SELECT id,code,name FROM warehouses ORDER BY code');
 return {success:true,page,limit,total,total_pages:Math.ceil(total/limit),shipments:rows,filters:{statuses:STATUS_VALUES(),carriers:carriers.map(x=>x.name),warehouses}};
}
function shipmentDetail(id){
 const shipment=get(`SELECT s.*,COALESCE(c.name,s.carrier) carrier_name,c.service_type,c.tracking_prefix,
  ow.code origin_warehouse_code,ow.name origin_warehouse_name,ow.location origin_warehouse_location,
  dw.code destination_warehouse_code,dw.name destination_warehouse_name,dw.location destination_warehouse_location
  FROM shipments s LEFT JOIN carriers c ON c.carrier_code=s.carrier_code
  LEFT JOIN warehouses ow ON ow.id=s.origin_warehouse_id LEFT JOIN warehouses dw ON dw.id=s.destination_warehouse_id WHERE s.id=?`,id);
 if(!shipment)return null;
 const items=all('SELECT id,sku,item_name,quantity FROM shipment_items WHERE shipment_id=? ORDER BY id',id);
 const disruptions=all(`SELECT d.id,d.disruption_code,d.title,d.disruption_type,d.severity,d.status,d.description,d.detected_at,d.resolved_at
  FROM disruptions d WHERE d.shipment_id=? ORDER BY d.detected_at DESC`,id);
 const orders=all(`SELECT DISTINCT o.id,o.order_number,o.status,o.priority,o.order_date,o.delivery_deadline
  FROM customer_orders o JOIN disruption_affected_orders x ON x.customer_order_id=o.id JOIN disruptions d ON d.id=x.disruption_id
  WHERE d.shipment_id=? ORDER BY o.delivery_deadline,o.id`,id);
 const recovery=all(`SELECT DISTINCT p.id,p.plan_code,p.title,p.status,p.created_at,p.updated_at,p.executed_at,p.execution_result_json,
  (SELECT COUNT(*) FROM recovery_actions ra WHERE ra.recovery_plan_id=p.id) action_count,
  (SELECT COUNT(*) FROM recovery_actions ra WHERE ra.recovery_plan_id=p.id AND ra.status IN ('Completed','Executed')) completed_actions,
  (SELECT COUNT(*) FROM approvals a WHERE a.recovery_plan_id=p.id AND a.status='Pending') pending_approvals
  FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id WHERE d.shipment_id=? AND p.data_origin='operational' ORDER BY p.created_at DESC`,id)
 const activities=all(`SELECT a.id,a.action event_type,a.details description,a.timestamp,a.entity_type,a.entity_id,a.data_origin
  FROM audit_logs a WHERE lower(a.entity_type)='shipment' AND a.entity_id=? ORDER BY a.timestamp DESC LIMIT 50`,String(id));
 const webhookEvents=all(`SELECT id,event_type event_type,processing_status status,received_at timestamp,payload_json
  FROM webhook_events WHERE payload_json LIKE ? ORDER BY received_at DESC LIMIT 50`,`%${shipment.tracking_number}%`);
 return {success:true,shipment,items,disruptions,orders,order_relationship_note:'Orders are shown only when linked through disruption_affected_orders for a disruption associated with this shipment. No direct shipment-to-order foreign key exists.',recovery,activities:[...activities.map(x=>({...x,source:'audit'})),...webhookEvents.map(x=>({...x,description:`Carrier webhook: ${x.event_type}`,source:'webhook'}))].sort((a,b)=>String(b.timestamp).localeCompare(String(a.timestamp))).slice(0,50)};
}
function shipmentCollection(id,type,params={}){
 const exists=get('SELECT id FROM shipments WHERE id=?',id);if(!exists)return null;
 const page=params.page||1,limit=params.limit||25,offset=(page-1)*limit;let rows=[];
 if(type==='items')rows=all('SELECT id,sku,item_name,quantity FROM shipment_items WHERE shipment_id=? ORDER BY id',id);
 if(type==='disruptions')rows=all('SELECT id,disruption_code,title,disruption_type,severity,status,description,detected_at,resolved_at FROM disruptions WHERE shipment_id=? ORDER BY detected_at DESC',id);
 if(type==='recovery')rows=all(`SELECT p.id,p.plan_code,p.title,p.status,p.created_at,p.updated_at,p.executed_at,(SELECT COUNT(*) FROM recovery_actions ra WHERE ra.recovery_plan_id=p.id) action_count FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id WHERE d.shipment_id=? AND p.data_origin='operational' ORDER BY p.created_at DESC`,id)
 if(type==='activities'){const events=shipmentDetail(id).activities,total=events.length;return {success:true,page,limit,total,total_pages:Math.ceil(total/limit),items:events.slice(offset,offset+limit)};}
 const total=rows.length;return {success:true,page,limit,total,total_pages:Math.ceil(total/limit),items:rows.slice(offset,offset+limit)};
}
module.exports={shipmentOverview,shipmentList,shipmentDetail,shipmentCollection,shipmentGeography};
