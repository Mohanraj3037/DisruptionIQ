'use strict';
// Seed a small, repeatable library of hypothetical scenarios. No operational rows
// are modified; simulation_service writes only simulation_runs.
const {db,get,all}=require('../src/database');
const {evaluateSimulation}=require('../src/services/simulation-service');
if(process.env.NODE_ENV==='production') { console.log('Production mode: demo simulations not seeded.'); db.close(); process.exit(0); }
const user=get("SELECT id FROM users WHERE email='hub@disruptioniq.local' AND is_active=1");
if(!user) throw new Error('Hub demo account is required to seed simulation examples.');
if(Number(get('SELECT COUNT(*) n FROM simulation_runs').n||0)>0){console.log('Simulation examples already exist.');db.close();process.exit(0);}
const shipments=all("SELECT id,tracking_number FROM shipments WHERE status<>'Delivered' ORDER BY risk_score DESC,id LIMIT 12");
const suppliers=all('SELECT id,name FROM suppliers WHERE is_active=1 ORDER BY risk_score DESC,id LIMIT 5');
const warehouses=all('SELECT id,code FROM warehouses WHERE is_active=1 ORDER BY code LIMIT 5');
const examples=[];
if(shipments[0])examples.push({scenario_type:'SHIPMENT_DELAY',title:'24-hour inbound shipment delay',shipment_id:shipments[0].id,delay_hours:24});
if(shipments[1])examples.push({scenario_type:'ROAD_ACCIDENT',title:'Road incident on priority lane',shipment_id:shipments[1].id,delay_hours:36});
if(shipments[2])examples.push({scenario_type:'SEVERE_WEATHER',title:'Severe weather disruption window',shipment_id:shipments[2].id,delay_hours:48});
if(suppliers[0])examples.push({scenario_type:'SUPPLIER_DISRUPTION',title:`Supplier interruption · ${suppliers[0].name}`,supplier_id:suppliers[0].id,delay_hours:72});
if(warehouses[0]){
 const stock=get('SELECT sku,MAX(0,quantity-reserved_quantity) available FROM inventories WHERE warehouse_id=? ORDER BY quantity ASC LIMIT 1',warehouses[0].id);
 if(stock)examples.push({scenario_type:'INVENTORY_SHORTAGE',title:`Inventory buffer stress · ${warehouses[0].code}`,warehouse_id:warehouses[0].id,sku:stock.sku,assumed_available:Math.max(0,Math.floor(stock.available*.55)),delay_hours:0});
}
let saved=0;
for(const item of examples){
 const outcome=evaluateSimulation(item,user.id,{persist:true});
 if(outcome.error) throw new Error(`Unable to seed ${item.title}: ${outcome.error}`);
 saved++;
}
console.log(`Seeded ${saved} saved scenario examples; operational shipment, order and inventory rows were not changed.`);
db.close();
