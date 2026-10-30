'use strict';
const crypto=require('node:crypto');
const {get,all,run,nowIso,audit}=require('../database');
function evaluateAndRecordShipmentDisruption(shipmentId,delayHours=0,reason=''){
 const shipment=get('SELECT * FROM shipments WHERE id=?',Number(shipmentId));if(!shipment)throw new Error('Shipment not found.');
 const now=new Date();let delay=Number(delayHours)||0;
 if(delay<=0&&shipment.estimated_arrival&&!shipment.actual_arrival){const estimated=new Date(shipment.estimated_arrival);delay=estimated<now?Math.max(24,Math.floor((now-estimated)/3600000)):48;}
 const code=`DIS-${shipment.tracking_number}`;let dis=get("SELECT * FROM disruptions WHERE shipment_id=? AND status='Active'",shipment.id)||get('SELECT * FROM disruptions WHERE disruption_code=?',code);
 const title=`Transit Delay — ${shipment.carrier||'Carrier'} (${shipment.tracking_number})`;
 const description=reason||`Shipment ${shipment.tracking_number} delayed by ${delay} hours en route to ${shipment.destination_city||'destination'}.`;
 if(!dis){const wh=shipment.destination_warehouse_id;const res=run(`INSERT INTO disruptions(disruption_code,title,disruption_type,severity,status,shortage_category,shipment_id,warehouse_id,location,description,estimated_delay_hours,detected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,code,title,'Carrier Delay','High','Active','Potential Shortage',shipment.id,wh,shipment.destination_city||'In Transit',description,delay,nowIso());dis=get('SELECT * FROM disruptions WHERE id=?',Number(res.lastInsertRowid));}
 else run(`UPDATE disruptions SET title=?,description=?,estimated_delay_hours=?,status='Active' WHERE id=?`,title,description,delay,dis.id);
 run("UPDATE shipments SET status='Delayed',ui_status='Delayed' WHERE id=?",shipment.id);
 const items=all('SELECT sku FROM shipment_items WHERE shipment_id=?',shipment.id);const skus=items.map(x=>x.sku);
 let affected=0;
 if(shipment.destination_warehouse_id&&skus.length){const candidates=all("SELECT * FROM customer_orders WHERE assigned_warehouse_id=? AND status IN ('Pending','Allocated','At Risk')",shipment.destination_warehouse_id);
  for(const o of candidates){const oi=all('SELECT * FROM order_items WHERE order_id=?',o.id).filter(x=>skus.includes(x.sku));let low=false;for(const item of oi){const inv=get('SELECT quantity,reserved_quantity FROM inventories WHERE warehouse_id=? AND sku=?',shipment.destination_warehouse_id,item.sku);if(!inv||Math.max(0,inv.quantity-inv.reserved_quantity)<50)low=true;}
   if(oi.length&&low){run("UPDATE customer_orders SET status='At Risk' WHERE id=?",o.id);const existing=get('SELECT 1 AS n FROM disruption_affected_orders WHERE disruption_id=? AND customer_order_id=?',dis.id,o.id);if(!existing){run('INSERT INTO disruption_affected_orders(disruption_id,customer_order_id) VALUES(?,?)',dis.id,o.id);affected++;}}
  }
 }
 if(affected>0)run("UPDATE disruptions SET severity='Critical',shortage_category='Potential Shortage' WHERE id=?",dis.id);
 return get('SELECT * FROM disruptions WHERE id=?',dis.id);
}
function detectWarehouseInventoryShortages(){
 const created=[];const warehouses=all('SELECT * FROM warehouses');
 for(const wh of warehouses){const inventories=all('SELECT * FROM inventories WHERE warehouse_id=?',wh.id);for(const inv of inventories){
  const pending=all("SELECT * FROM customer_orders WHERE assigned_warehouse_id=? AND status IN ('Pending','Allocated','At Risk')",wh.id);const ids=pending.map(o=>o.id);if(!ids.length)continue;
  const marks=ids.map(()=>'?').join(',');const demand=Number(get(`SELECT COALESCE(SUM(quantity),0) AS n FROM order_items WHERE sku=? AND order_id IN (${marks})`,inv.sku,...ids).n||0);if(!(demand>Math.max(0,inv.quantity-inv.reserved_quantity)&&demand>0))continue;
  const code=`DIS-${wh.code}-${inv.sku}`;let existing=get("SELECT * FROM disruptions WHERE disruption_code=? AND status='Active'",code);
  const inbound=all("SELECT s.id FROM shipments s JOIN shipment_items si ON si.shipment_id=s.id WHERE s.destination_warehouse_id=? AND s.status IN ('In Transit','Delayed','Scheduled') AND si.sku=?",wh.id,inv.sku).length>0;
  const type=inbound?'Potential Shortage':'Confirmed Shortage';const available=Math.max(0,inv.quantity-inv.reserved_quantity);const deficit=demand-available;
  if(!existing){const r=run(`INSERT INTO disruptions(disruption_code,title,disruption_type,severity,status,shortage_category,warehouse_id,location,description,estimated_delay_hours,detected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,code,`${wh.code} Inventory Shortage — ${inv.item_name} (${inv.sku})`,'Warehouse Stockout',inbound?'High':'Critical','Active',type,wh.id,`${wh.name} (${wh.location})`,`Deficit of ${deficit} units for ${inv.item_name} (${inv.sku}) at ${wh.code}. Total customer demand is ${demand} units, but only ${available} available in stock. ${inbound?'Incoming shipment delayed or scheduled.':'No incoming shipments registered.'}`,48,nowIso());existing=get('SELECT * FROM disruptions WHERE id=?',Number(r.lastInsertRowid));created.push(existing);}
  else run('UPDATE disruptions SET shortage_category=?,description=? WHERE id=?',type,`Deficit of ${deficit} units for ${inv.item_name} (${inv.sku}) at ${wh.code}. Demand: ${demand}, Available: ${available}.`,existing.id);
  for(const order of pending){const match=get(`SELECT 1 AS n FROM order_items WHERE order_id=? AND sku=?`,order.id,inv.sku);if(!match)continue;run("UPDATE customer_orders SET status='At Risk' WHERE id=?",order.id);run('INSERT OR IGNORE INTO disruption_affected_orders(disruption_id,customer_order_id) VALUES(?,?)',existing.id,order.id);}
 }}
 return created;
}
function runFullDisruptionScan(actor){
 const delayed=all("SELECT id,status,estimated_arrival,actual_arrival FROM shipments WHERE status IN ('Delayed','In Transit')");let checked=0;
 for(const s of delayed){const isDelayed=s.status==='Delayed'||(s.estimated_arrival&&!s.actual_arrival&&new Date(s.estimated_arrival)<new Date());if(isDelayed){evaluateAndRecordShipmentDisruption(s.id);checked++;}}
 const shortages=detectWarehouseInventoryShortages();const active=get("SELECT COUNT(*) AS n FROM disruptions WHERE status='Active'").n;const potential=get("SELECT COUNT(*) AS n FROM disruptions WHERE status='Active' AND shortage_category='Potential Shortage'").n;const confirmed=get("SELECT COUNT(*) AS n FROM disruptions WHERE status='Active' AND shortage_category='Confirmed Shortage'").n;const affected=get("SELECT COUNT(*) AS n FROM customer_orders WHERE status='At Risk'").n;
 const timestamp=nowIso();
 const signals={network_anomaly_index:crypto.randomInt(18,96),carrier_variance_index:crypto.randomInt(12,94),route_congestion_index:crypto.randomInt(15,98),inventory_pressure_index:crypto.randomInt(10,92)};
 const summary={delayed_shipments_evaluated:checked,warehouse_shortages_evaluated:shortages.length,active_disruptions_count:active,active_disruptions:active,potential_shortages:potential,confirmed_shortages:confirmed,affected_orders:affected,timestamp,scan_mode:'synthetic_signal_simulation',simulated_signals:signals};
 let scanCode=null;
 if(actor?.id){scanCode=`SCAN-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  run(`INSERT INTO simulation_runs(simulation_code,created_by_id,scenario_type,title,parameters_json,result_json,created_at,data_origin) VALUES(?,?,? ,?,?,?,?,'simulated')`,scanCode,actor.id,'DISRUPTION_SCAN','Synthetic network disruption scan',JSON.stringify({mode:'randomized_signal_overlay',source:'current SQLite operational snapshot'}),JSON.stringify(summary),timestamp);
  audit({userId:actor.id,action:'DISRUPTION_SCAN',entityType:'DisruptionScan',entityId:scanCode,details:JSON.stringify(summary)});
 }
 for(const roleName of ['HUB_INCHARGE','RISK_ANALYST','RECOVERY_MANAGER']){
  run(`INSERT INTO notifications(recipient_role,title,message,category,is_read,created_at,data_origin) VALUES(?,?,?,?,0,?,'simulated')`,roleName,'Disruption scan completed',`Scan ${scanCode||'completed'}: ${active} active incidents, ${affected} affected orders. Randomized signal indices are illustrative simulation values, not measured telemetry.`, 'Info',timestamp);
 }
 return {...summary,scan_code:scanCode};
}
module.exports={evaluateAndRecordShipmentDisruption,detectWarehouseInventoryShortages,runFullDisruptionScan};
