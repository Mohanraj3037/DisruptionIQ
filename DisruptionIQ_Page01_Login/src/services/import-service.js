'use strict';
const {db,get,all,run,nowIso,audit}=require('../database');

const MAX_FILE_SIZE=2*1024*1024;
const VALID_SHIPMENT_STATUSES=new Set(['Scheduled','In Transit','Delayed','Delivered','Cancelled']);
const VALID_MODES=new Set(['Ocean','Air','Road','Rail']);

function parseCSV(text){
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<String(text).length;i++){
  const c=text[i],n=text[i+1];
  if(c==='"'&&quoted&&n==='"'){cell+='"';i++;}
  else if(c==='"')quoted=!quoted;
  else if(c===','&&!quoted){row.push(cell);cell='';}
  else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&n==='\n')i++;row.push(cell);if(row.some(x=>x.trim()!==''))rows.push(row);row=[];cell='';}
  else cell+=c;
 }
 row.push(cell);if(row.some(x=>x.trim()!==''))rows.push(row);
 if(!rows.length)return[];
 const headers=rows.shift().map(x=>x.replace(/^\uFEFF/,'').trim().toLowerCase().replace(/[\s-]+/g,'_'));
 return rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,(r[i]??'').trim()])));
}
function parseDate(value,label){
 if(value===undefined||value===null||String(value).trim()==='')return null;
 const date=new Date(value);if(Number.isNaN(date.getTime()))throw new Error(`${label}: invalid date '${value}'. Expected YYYY-MM-DD or ISO 8601.`);
 return date.toISOString();
}
function integer(value,label,{min=0,defaultValue=0}={}){
 if(value===undefined||value===null||String(value).trim()==='')return defaultValue;
 const n=Number(value);if(!Number.isInteger(n)||n<min)throw new Error(`${label} must be an integer greater than or equal to ${min}.`);return n;
}
function decimal(value,label,{min=0,defaultValue=0}={}){
 if(value===undefined||value===null||String(value).trim()==='')return defaultValue;
 const n=Number(value);if(!Number.isFinite(n)||n<min)throw new Error(`${label} must be a number greater than or equal to ${min}.`);return n;
}
function importRecords(entity,records,user,{dryRun=false,filename='api-upload',allowUpdates=false}={}){
 if(!Array.isArray(records)||records.length===0)throw new Error('The uploaded data contains no records.');
 if(records.length>10000)throw new Error('Provide up to 10,000 records per import.');
 const errors=[],valid=[],seen=new Set();
 const warehouses=new Map(all('SELECT id,code FROM warehouses').map(x=>[x.code,x]));
 const suppliers=new Map(all('SELECT id,code FROM suppliers').map(x=>[x.code,x]));
 const existingWarehouses=new Set(warehouses.keys()),existingSuppliers=new Set(suppliers.keys());
 for(let i=0;i<records.length;i++){
  const r=records[i]||{};const rowNo=i+2;
  try{
   if(entity==='shipments'){
    const tracking=String(r.tracking_number||'').trim();if(!tracking)throw new Error("Missing required field 'tracking_number'.");if(get('SELECT id FROM shipments WHERE tracking_number=?',tracking)&&!allowUpdates)throw new Error(`Shipment '${tracking}' already exists. Tick the explicit update confirmation to allow a matching-record update.`);
    if(seen.has(tracking))throw new Error(`Duplicate tracking number '${tracking}' within the same import file.`);seen.add(tracking);
    const destCode=String(r.destination_warehouse_code||'').trim(),dest=warehouses.get(destCode);if(!dest)throw new Error(`Destination warehouse '${destCode}' does not exist.`);
    const supplierCode=String(r.supplier_code||'').trim(),supplier=supplierCode?suppliers.get(supplierCode):null;if(supplierCode&&!supplier)throw new Error(`Supplier '${supplierCode}' does not exist.`);
    const originCode=String(r.origin_warehouse_code||'').trim(),origin=originCode?warehouses.get(originCode):null;if(originCode&&!origin)throw new Error(`Origin warehouse '${originCode}' does not exist.`);
    const mode=String(r.transport_mode||'Ocean').trim(),status=String(r.status||'In Transit').trim();if(!VALID_MODES.has(mode))throw new Error(`Invalid transport mode '${mode}'. Must be Ocean, Air, Road or Rail.`);if(!VALID_SHIPMENT_STATUSES.has(status))throw new Error(`Invalid status '${status}'.`);
    const sku=String(r.sku||'').trim();const quantity=sku?integer(r.quantity,'quantity',{min:1,defaultValue:1}):0;
    valid.push({tracking_number:tracking,supplier_id:supplier?.id||null,origin_warehouse_id:origin?.id||null,destination_warehouse_id:dest.id,carrier:String(r.carrier||'Unassigned Carrier').trim(),transport_mode:mode,status,origin_city:String(r.origin_city||'Global Hub').trim(),destination_city:String(r.destination_city||destCode).trim(),estimated_departure:parseDate(r.estimated_departure,'Estimated departure'),estimated_arrival:parseDate(r.estimated_arrival||r.eta,'Estimated arrival'),ui_status:status,risk_score:decimal(r.risk_score??r.risk,'risk_score'),progress:decimal(r.progress,'progress',{min:0,defaultValue:0}),unit_count:integer(r.unit_count??r.units,'unit_count',{min:0,defaultValue:quantity}),eta_label:String(r.eta_label||r.eta||'').trim()||null,sku,item_name:String(r.item_name||sku).trim(),quantity});
   }else if(entity==='inventory'){
    const warehouseCode=String(r.warehouse_code||'').trim(),warehouse=warehouses.get(warehouseCode);if(!warehouse)throw new Error(`Warehouse '${warehouseCode}' does not exist.`);
    const sku=String(r.sku||'').trim();if(!sku)throw new Error("Missing required field 'sku'.");
    const key=`${warehouseCode}:${sku}`;if(get('SELECT id FROM inventories WHERE warehouse_id=? AND sku=?',warehouse.id,sku)&&!allowUpdates)throw new Error(`Inventory '${key}' already exists. Tick the explicit update confirmation to allow a matching-record update.`);if(seen.has(key))throw new Error(`Duplicate inventory record for SKU '${sku}' at warehouse '${warehouseCode}' within the same import file.`);seen.add(key);
    const itemName=String(r.item_name||'').trim();if(!itemName)throw new Error("Missing required field 'item_name'.");
    valid.push({warehouse_id:warehouse.id,warehouse_code:warehouseCode,sku,item_name:itemName,category:String(r.category||'General Logistics').trim(),quantity:integer(r.quantity,'quantity'),reserved_quantity:integer(r.reserved_quantity,'reserved_quantity'),reorder_point:integer(r.reorder_point,'reorder_point',{defaultValue:10}),unit_cost:decimal(r.unit_cost,'unit_cost')});
   }else if(entity==='suppliers'){
    const code=String(r.code||r.supplier_code||'').trim(),name=String(r.name||'').trim();if(!code)throw new Error("Missing required field 'code'.");if(!name)throw new Error("Missing required field 'name'.");if(seen.has(code))throw new Error(`Duplicate supplier code '${code}' within this import.`);seen.add(code);if(existingSuppliers.has(code))throw new Error(`Supplier '${code}' already exists. Existing suppliers are never overwritten by import.`);
    const reliability=decimal(r.reliability_score,'reliability_score',{min:0,defaultValue:1});if(reliability>1)throw new Error('reliability_score must be between 0 and 1.');
    valid.push({code,name,country:String(r.country||'').trim()||null,city:String(r.city||'').trim()||null,reliability_score:reliability,lead_time_days:integer(r.lead_time_days,'lead_time_days',{min:0,defaultValue:7}),expected_supply_date:parseDate(r.expected_supply_date,'Expected supply date'),contact_email:String(r.contact_email||'').trim()||null,region:String(r.region||'').trim()||null,risk_score:decimal(r.risk_score,'risk_score'),exposure:String(r.exposure||'').trim()||null,is_active:r.is_active===undefined?1:(['1','true','yes'].includes(String(r.is_active).toLowerCase())?1:0)});
   }else if(entity==='warehouses'){
    const code=String(r.code||r.warehouse_code||'').trim(),name=String(r.name||'').trim();if(!code)throw new Error("Missing required field 'code'.");if(!name)throw new Error("Missing required field 'name'.");if(seen.has(code))throw new Error(`Duplicate warehouse code '${code}' within this import.`);seen.add(code);if(existingWarehouses.has(code))throw new Error(`Warehouse '${code}' already exists. Existing warehouses are never overwritten by import.`);
    const capacity=decimal(r.capacity_sqm,'capacity_sqm'),util=decimal(r.current_utilization,'current_utilization');if(util>100)throw new Error('current_utilization must be between 0 and 100.');
    valid.push({code,name,location:String(r.location||'').trim()||null,capacity_sqm:capacity,current_utilization:util,is_active:r.is_active===undefined?1:(['1','true','yes'].includes(String(r.is_active).toLowerCase())?1:0)});
   }else throw new Error('Supported entities: suppliers, warehouses, shipments, inventory.');
  }catch(e){errors.push({row:rowNo,identifier:r.tracking_number||`${r.warehouse_code||''}/${r.sku||''}`||'Unknown',error:e.message});}
 }
 if(errors.length){audit({userId:user?.id,action:'IMPORT_FAILED',entityType:entity,details:JSON.stringify({filename,received:records.length,valid:valid.length,errors:errors.length})});return{success:false,entity,filename,total_rows:records.length,valid_count:valid.length,rejected:errors.length,errors:errors.slice(0,100),preview:valid.slice(0,5),dry_run:!!dryRun};}
 if(dryRun)return{success:true,dry_run:true,entity,filename,total_rows:records.length,valid_count:valid.length,errors:[],preview:valid.slice(0,5),message:'Validation passed. No database records were changed.'};
 let inserted=0,updated=0;
 try{
  db.exec('BEGIN IMMEDIATE');
  for(const r of valid){
   if(entity==='shipments'){
    const old=get('SELECT * FROM shipments WHERE tracking_number=?',r.tracking_number);
    const values=[r.supplier_id,r.origin_warehouse_id,r.destination_warehouse_id,r.carrier,r.transport_mode,r.status,r.origin_city,r.destination_city,r.estimated_departure, r.estimated_arrival,r.ui_status,r.risk_score,r.progress,r.unit_count,r.eta_label];
    let shipmentId;
    if(old){run(`UPDATE shipments SET supplier_id=?,origin_warehouse_id=?,destination_warehouse_id=?,carrier=?,transport_mode=?,status=?,origin_city=?,destination_city=?,estimated_departure=COALESCE(?,estimated_departure),estimated_arrival=COALESCE(?,estimated_arrival),ui_status=?,risk_score=?,progress=?,unit_count=?,eta_label=? WHERE id=?`,...values,old.id);shipmentId=old.id;updated++;}
    else{const ins=run(`INSERT INTO shipments(tracking_number,supplier_id,origin_warehouse_id,destination_warehouse_id,carrier,transport_mode,status,origin_city,destination_city,estimated_departure,estimated_arrival,created_at,ui_status,risk_score,progress,unit_count,eta_label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,r.tracking_number,r.supplier_id,r.origin_warehouse_id,r.destination_warehouse_id,r.carrier,r.transport_mode,r.status,r.origin_city,r.destination_city,r.estimated_departure,r.estimated_arrival,nowIso(),r.ui_status,r.risk_score,r.progress,r.unit_count,r.eta_label);shipmentId=Number(ins.lastInsertRowid);inserted++;}
    if(r.sku){const item=get('SELECT id FROM shipment_items WHERE shipment_id=? AND sku=?',shipmentId,r.sku);if(item)run('UPDATE shipment_items SET item_name=?,quantity=? WHERE id=?',r.item_name||r.sku,r.quantity,item.id);else run('INSERT INTO shipment_items(shipment_id,sku,item_name,quantity) VALUES(?,?,?,?)',shipmentId,r.sku,r.item_name||r.sku,r.quantity);}
   }else if(entity==='suppliers'){
    run(`INSERT INTO suppliers(code,name,country,city,reliability_score,lead_time_days,expected_supply_date,contact_email,is_active,created_at,region,risk_score,exposure) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,r.code,r.name,r.country,r.city,r.reliability_score,r.lead_time_days,r.expected_supply_date,r.contact_email,r.is_active,nowIso(),r.region,r.risk_score,r.exposure);inserted++;
   }else if(entity==='warehouses'){
    run(`INSERT INTO warehouses(code,name,location,capacity_sqm,current_utilization,is_active,created_at) VALUES(?,?,?,?,?,?,?)`,r.code,r.name,r.location,r.capacity_sqm,r.current_utilization,r.is_active,nowIso());inserted++;
   }else{
    const old=get('SELECT id FROM inventories WHERE warehouse_id=? AND sku=?',r.warehouse_id,r.sku);
    const values=[r.item_name,r.category,r.quantity,r.reserved_quantity,r.reorder_point,r.unit_cost,nowIso()];
    if(old){run('UPDATE inventories SET item_name=?,category=?,quantity=?,reserved_quantity=?,reorder_point=?,unit_cost=?,updated_at=? WHERE id=?',...values,old.id);updated++;}
    else{run('INSERT INTO inventories(warehouse_id,sku,item_name,category,quantity,reserved_quantity,reorder_point,unit_cost,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',r.warehouse_id,r.sku,...values);inserted++;}
   }
  }
  audit({userId:user?.id,action:`IMPORT_${entity.toUpperCase()}`,entityType:entity,details:JSON.stringify({filename,inserted,updated,rows:valid.length})});
  db.exec('COMMIT');
 }catch(e){try{db.exec('ROLLBACK');}catch{}audit({userId:user?.id,action:'IMPORT_FAILED',entityType:entity,details:`${filename}: ${e.message}`});return{success:false,entity,filename,total_rows:records.length,inserted:0,updated:0,rejected:records.length,errors:[{row:0,error:`Database transaction failed: ${e.message}`}],preview:[]};}
 return{success:true,dry_run:false,entity,filename,total_rows:records.length,inserted,updated,rejected:0,errors:[],preview:valid.slice(0,5)};
}
module.exports={MAX_FILE_SIZE,parseCSV,importRecords};
