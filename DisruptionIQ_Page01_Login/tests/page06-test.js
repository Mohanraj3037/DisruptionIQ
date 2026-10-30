'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const PORT=Number(process.env.PAGE06_TEST_PORT||5276),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'diq-page06-')),dbPath=path.join(tmp,'page06.db');
const HUB_PASSWORD='Hub@DIQ2026!',CUSTOMER_PASSWORD='Customer@DIQ2026!';
const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(PORT),HOST:'127.0.0.1',DATABASE_PATH:dbPath,DEMO_HUB_PASSWORD:HUB_PASSWORD,DEMO_CUSTOMER_PASSWORD:CUSTOMER_PASSWORD,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',b=>output+=b.toString());child.stderr.on('data',b=>output+=b.toString());
const base=`http://127.0.0.1:${PORT}`,sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(output);try{if((await fetch(base+'/health')).ok)return;}catch{}await sleep(100);}throw Error('Page 06 test server did not start. '+output);}
function session(r){const c=r.headers.getSetCookie().map(x=>x.split(';')[0]);return{cookie:c.join('; '),csrf:decodeURIComponent(c.find(x=>x.startsWith('diq_csrf=')).split('=').slice(1).join('='))};}
async function login(email,password){const r=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200);return session(r);}
async function call(s,url){const r=await fetch(base+url,{headers:{Cookie:s.cookie}});return{status:r.status,payload:await r.json().catch(()=>({}))};}
(async()=>{try{
 await wait();const hub=await login('hub@disruptioniq.local',HUB_PASSWORD),customer=await login('customer@disruptioniq.local',CUSTOMER_PASSWORD);
 let r=await call(hub,'/api/v1/hubs?limit=1');assert.equal(r.status,200);const hubId=r.payload.hubs[0].id;assert.ok(hubId>0);
 r=await call(hub,`/api/v1/hubs/${hubId}`);assert.equal(r.status,200);assert.equal(r.payload.hub.id,hubId);assert.ok(r.payload.hub.hub_code);assert.ok(r.payload.hub.relationship_notes.order_association.includes('no direct shipment-to-order'));
 const types=['shipments','disruptions','inventory','orders','recovery','activities'];
 for(const type of types){r=await call(hub,`/api/v1/hubs/${hubId}/${type}?page=1&limit=2`);assert.equal(r.status,200,`${type}: ${JSON.stringify(r.payload)}`);assert.equal(r.payload.hub_id,hubId);assert.ok(Array.isArray(r.payload.items));assert.ok(r.payload.items.length<=2);assert.equal(r.payload.page,1);assert.equal(r.payload.limit,2);}
 const db=new DatabaseSync(dbPath);try{const expected=db.prepare('SELECT COUNT(DISTINCT id) n FROM shipments WHERE origin_warehouse_id=? OR destination_warehouse_id=?').get(hubId,hubId).n;r=await call(hub,`/api/v1/hubs/${hubId}/shipments?limit=100`);assert.equal(r.payload.total,expected);const ids=r.payload.items.map(x=>x.id);assert.equal(new Set(ids).size,ids.length,'Shipment rows must not duplicate.');}finally{db.close();}
 r=await call(hub,`/api/v1/hubs/${hubId}/inventory?q=sku&limit=3`);assert.equal(r.status,200);assert.ok(r.payload.items.length<=3);
 const verifyDb=new DatabaseSync(dbPath);try{const invExpected=verifyDb.prepare('SELECT COUNT(*) n FROM inventories WHERE warehouse_id=?').get(hubId).n;const disruptionExpected=verifyDb.prepare(`SELECT COUNT(DISTINCT d.id) n FROM disruptions d LEFT JOIN shipments s ON s.id=d.shipment_id WHERE d.warehouse_id=? OR s.origin_warehouse_id=? OR s.destination_warehouse_id=? OR EXISTS(SELECT 1 FROM inventories ix WHERE upper(COALESCE(d.source_entity_type,''))='INVENTORY' AND ix.source_record_id=d.source_entity_id AND ix.warehouse_id=?)`).get(hubId,hubId,hubId,hubId).n;r=await call(hub,`/api/v1/hubs/${hubId}/inventory?limit=100`);assert.equal(r.payload.total,invExpected);r=await call(hub,`/api/v1/hubs/${hubId}/disruptions?limit=100`);assert.equal(r.payload.total,disruptionExpected);assert.ok(r.payload.items.every(x=>!('customer_name' in x)));}finally{verifyDb.close();}
 r=await call(hub,`/api/v1/hubs/${hubId}/shipments?status=delayed&limit=100`);assert.equal(r.status,200);assert.ok(r.payload.items.every(x=>x.status.toLowerCase()==='delayed'));
 r=await call(hub,`/api/v1/hubs/${hubId}/shipments?page=2&limit=1`);assert.equal(r.status,200);if(r.payload.total>1)assert.notEqual(r.payload.items[0]?.id,(await call(hub,`/api/v1/hubs/${hubId}/shipments?page=1&limit=1`)).payload.items[0]?.id);
 r=await call(hub,'/api/v1/hubs/999999999');assert.equal(r.status,404);
 for(const type of types){r=await call(hub,`/api/v1/hubs/999999999/${type}`);assert.equal(r.status,404,`missing hub ${type}`);}
 r=await call(hub,`/api/v1/hubs/${hubId}/shipments?page=0&limit=25`);assert.equal(r.status,400);
 for(const endpoint of [`/api/v1/hubs/${hubId}`,...types.map(t=>`/api/v1/hubs/${hubId}/${t}`),'/api/v1/hubs/overview','/api/v1/hubs']){r=await call(customer,endpoint);assert.equal(r.status,403,`Customer must be blocked: ${endpoint}`);}
 const page=await fetch(base+`/app/hub-details?id=${hubId}`,{headers:{Cookie:hub.cookie}});assert.equal(page.status,200);const html=await page.text();assert.match(html,/page-hub-details/);assert.match(html,/hubDetailsTableBody/);
 const customerPage=await fetch(base+`/app/hub-details?id=${hubId}`,{headers:{Cookie:customer.cookie},redirect:'manual'});assert.equal(customerPage.status,403);
 console.log('PASS Page 06 hub detail identity, metadata and relationship notes');
 console.log('PASS all six hub detail collections, filtering, pagination and no duplicate shipments');
 console.log('PASS missing hub 404, invalid pagination 400 and Customer 403 for all internal APIs/pages');
 console.log('PASS Page 06 direct route and existing Hub Overview route integration');
 }catch(e){console.error('PAGE 06 TEST FAILED:',e);console.error(output);process.exitCode=1;}finally{child.kill();setTimeout(()=>fs.rmSync(tmp,{recursive:true,force:true}),100);}})();
