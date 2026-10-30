'use strict';
// Deterministic, idempotent synthetic routing fixture so the city map reflects
// connected origin/destination hubs rather than same-city placeholder pairs.
const {db,all,get,run,nowIso}=require('../src/database');
const cityMeta={
  Chennai:['Tamil Nadu',13.08784,80.27847],Bengaluru:['Karnataka',12.97194,77.59369],
  Hyderabad:['Telangana',17.38405,78.45636],Mumbai:['Maharashtra',19.07283,72.88261],
  Pune:['Maharashtra',18.51957,73.85535],Delhi:['Delhi',28.65195,77.23149],
  Kolkata:['West Bengal',22.56263,88.36304],Ahmedabad:['Gujarat',23.02579,72.58727],
  Coimbatore:['Tamil Nadu',11.00555,76.96612],Jaipur:['Rajasthan',26.91962,75.78781],
  Kochi:['Kerala',9.93120,76.26730],Lucknow:['Uttar Pradesh',26.83928,80.92313],
  Guwahati:['Assam',26.14450,91.73620]
};
const canon=value=>{
  const key=String(value||'').split(',')[0].trim().toLowerCase();
  const aliases={bangalore:'Bengaluru',cochin:'Kochi','new delhi':'Delhi','delhi ncr':'Delhi'};
  const alias=aliases[key];if(alias)return alias;
  return Object.keys(cityMeta).find(x=>x.toLowerCase()===key)||null;
};
const whByCity=new Map(),supByCity=new Map();
for(const w of all('SELECT id,code,name,location FROM warehouses ORDER BY id')){const c=canon(w.location);if(c&&!whByCity.has(c))whByCity.set(c,w);}
for(const s of all('SELECT id,code,name,city,state FROM suppliers ORDER BY id')){const c=canon(s.city);if(c&&!supByCity.has(c))supByCity.set(c,s);}
const now=nowIso();
for(const [city,[state]] of Object.entries(cityMeta)){
  if(!whByCity.has(city)){
    const code=`WH-${city.toUpperCase().replace(/[^A-Z]/g,'').slice(0,3)}-DEMO`;
    run(`INSERT OR IGNORE INTO warehouses(code,name,location,capacity_sqm,current_utilization,capacity_units,is_active,created_at,data_origin)
      VALUES(?,?,?,2400,0.48,12000,1,?,'synthetic')`,code,`${city} Regional Distribution Hub`,`${city}, ${state}, India`,now);
    whByCity.set(city,get('SELECT id,code,name,location FROM warehouses WHERE code=?',code));
  }
  if(!supByCity.has(city)){
    const code=`SUP-${city.toUpperCase().replace(/[^A-Z]/g,'').slice(0,3)}-DEMO`;
    run(`INSERT OR IGNORE INTO suppliers(code,name,country,city,state,reliability_score,lead_time_days,contact_email,is_active,created_at,region,risk_score,exposure,data_origin)
      VALUES(?,?,'India',?,?,0.86,6,?,1,?,'India',34,'Regional synthetic network fixture','synthetic')`,code,`${city} Network Supply Partner`,city,state,`${city.toLowerCase()}-partner@example.invalid`,now);
    supByCity.set(city,get('SELECT id,code,name,city,state FROM suppliers WHERE code=?',code));
  }
}
const allCities=Object.keys(cityMeta);
const warehousesByCity=whByCity;
// Reconcile the imported synthetic shipment's hub foreign keys with its known
// supplier origin, and assign a deterministic next-node corridor. This is an
// explicit synthetic network fixture, not a claim about a real dispatch route.
const syntheticShipments=all(`SELECT s.id,s.tracking_number,s.supplier_id,s.origin_city,s.destination_city,sp.city supplier_city
  FROM shipments s LEFT JOIN suppliers sp ON sp.id=s.supplier_id WHERE s.data_origin='synthetic' ORDER BY s.id`);
db.exec('BEGIN IMMEDIATE');
try{
  for(const shipment of syntheticShipments){
    const origin=canon(shipment.origin_city||shipment.supplier_city);if(!origin)continue;
    const idx=allCities.indexOf(origin);if(idx<0)continue;
    const destination=allCities[(idx+1)%allCities.length];
    const originWh=warehousesByCity.get(origin),destWh=warehousesByCity.get(destination);
    if(!originWh||!destWh)continue;
    run(`UPDATE shipments SET origin_warehouse_id=?,destination_warehouse_id=?,origin_city=?,destination_city=? WHERE id=?`,
      originWh.id,destWh.id,origin,destination,shipment.id);
    run(`UPDATE disruptions SET warehouse_id=?,location=? WHERE shipment_id=? AND source_entity_type='SHIPMENT'`,destWh.id,destWh.location,shipment.id);
  }
  // Add inbound and outbound Guwahati demonstration corridors so the Northeast
  // is represented even if the imported workbook has no Guwahati supplier.
  const carrier=get('SELECT carrier_code,name,service_type FROM carriers ORDER BY carrier_code LIMIT 1')||{carrier_code:null,name:'India Network Logistics',service_type:'Road'};
  if(!carrier.carrier_code){run(`INSERT OR IGNORE INTO carriers(carrier_code,name,service_type,tracking_prefix,data_origin) VALUES('NET-DEMO','India Network Logistics','Road','NET','synthetic')`);}
  const activeCarrier=get('SELECT carrier_code,name,service_type FROM carriers ORDER BY carrier_code LIMIT 1');
  let sampleIndex=0;
  for(const city of allCities.filter(x=>x!=='Guwahati')){
    const pairs=[['Guwahati',city], [city,'Guwahati']];
    for(const [from,to] of pairs){
      const tracking=`NET-GHY-${from.slice(0,3).toUpperCase()}-${to.slice(0,3).toUpperCase()}`;
      const existing=get('SELECT id FROM shipments WHERE tracking_number=?',tracking);
      if(existing)continue;
      sampleIndex++;
      const supplier=supByCity.get(from),originWh=whByCity.get(from),destWh=whByCity.get(to);
      const status=['In Transit','Delayed','Delivered','Scheduled'][sampleIndex%4];
      const created=new Date(Date.now()-(sampleIndex+2)*86400000).toISOString();
      const eta=new Date(Date.now()+(2+(sampleIndex%5))*86400000).toISOString();
      const risk=status==='Delayed'?72:status==='In Transit'?42:status==='Delivered'?16:31;
      const inserted=run(`INSERT INTO shipments(tracking_number,supplier_id,origin_warehouse_id,destination_warehouse_id,carrier,carrier_code,transport_mode,status,ui_status,origin_city,destination_city,estimated_departure,actual_departure,estimated_arrival,actual_arrival,created_at,risk_score,progress,unit_count,eta_label,data_origin,source_record_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'synthetic',?)`,tracking,supplier.id,originWh.id,destWh.id,activeCarrier.name,activeCarrier.carrier_code,activeCarrier.service_type||'Road',status,status,from,to,created,created,eta,status==='Delivered'?eta:null,created,risk,status==='Delivered'?100:status==='In Transit'?42:0,18+(sampleIndex%60),status==='Delivered'?'Delivered':status==='Delayed'?'Delayed':`${2+(sampleIndex%5)} days`,tracking);
      run(`INSERT INTO shipment_items(shipment_id,sku,item_name,quantity,data_origin) VALUES(?,?,?,?, 'synthetic')`,Number(inserted.lastInsertRowid),'SKU-NETWORK-DEMO',`Regional network sample cargo`,18+(sampleIndex%60));
    }
  }
  db.exec('COMMIT');
}catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
const result={synthetic_shipments_reconciled:syntheticShipments.length,city_nodes:Object.keys(cityMeta).length,guwahati_corridor_shipments:all(`SELECT id FROM shipments WHERE tracking_number LIKE 'NET-GHY-%'`).length,shipment_total:Number(get('SELECT COUNT(*) n FROM shipments').n||0)};
console.log(JSON.stringify(result,null,2));
db.close();
