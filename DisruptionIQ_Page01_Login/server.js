'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {db,get,all,run,nowIso,audit}=require('./src/database');
const {verifyPassword,createSession,getSessionFromRequest,destroySession,canAccess,verifyCsrf,cookieMap}=require('./src/security');
const {getDashboardData,getDashboardSummary}=require('./src/services/data-service');
const {getHubOverview,listHubs,getHubById,getHubActivities,getHubDetails,getHubCollection}=require('./src/services/hub-service');
const {shipmentOverview,shipmentList,shipmentDetail,shipmentCollection,shipmentGeography}=require('./src/services/shipment-service');
const {supplierOverview,supplierList,supplierDetail,supplierCollection}=require('./src/services/supplier-service');
const {inventoryOverview,warehouseList,warehouseDetail,warehouseCollection,inventoryRegister,inventoryDetail,productInventory}=require('./src/services/inventory-service');
const {orderOverview,orderList,orderDetail,orderItems,orderShipments,orderDisruptions,orderRisk,orderRecovery,orderActivities}=require('./src/services/order-service');
const {scoreAndRankAllAffectedOrders,calculateOrderRisk}=require('./src/domain/risk-engine');
const {analyzeDisruptionImpact}=require('./src/domain/impact-engine');
const {runFullDisruptionScan,evaluateAndRecordShipmentDisruption}=require('./src/domain/disruption-engine');
const {generateRecoveryRecommendations,createPlanFromRecommendation,submitPlanForApproval,reviewPlanApproval,modifyRecoveryPlan,executeSimulatedRecoveryPlan}=require('./src/domain/recovery-engine');
const {getDisruptionSummary,deterministicOrderExplanation,explainOrderRisk,explainOrderRanking,explainRecoveryCandidate,getScenarioComparison,clearCache}=require('./src/services/ai-insight-service');
const {parseCSV,importRecords}=require('./src/services/import-service');
const {evaluateSimulation,listSimulations,getSimulation}=require('./src/services/simulation-service');
const {nextBrowserSafePort,normalizeBrowserSafePort}=require('./src/utils/browser-safe-port');
// Audit history is append-only during application runtime. Bootstrap archives
// imported synthetic fixtures before the HTTP server is started.
db.exec(`CREATE TRIGGER IF NOT EXISTS audit_logs_no_update BEFORE UPDATE ON audit_logs
  BEGIN SELECT RAISE(ABORT,'Audit log records are immutable.'); END;
  CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete BEFORE DELETE ON audit_logs
  BEGIN SELECT RAISE(ABORT,'Audit log records are immutable.'); END;`);

const ROOT=__dirname,PUBLIC=path.join(ROOT,'public');
const REQUESTED_PORT=Number(process.env.PORT||3000),BASE_PORT=normalizeBrowserSafePort(REQUESTED_PORT),HOST=process.env.HOST||'127.0.0.1';
const PORT_FALLBACK_ENABLED=process.env.PORT_FALLBACK!=='false';
const MAX_PORT_ATTEMPTS=Math.max(1,Number(process.env.PORT_SCAN_LIMIT||30));
const ROLES=['HUB_INCHARGE','RISK_ANALYST','RECOVERY_MANAGER','CUSTOMER'];
const AUTH_ROLES=ROLES;
const ROLE_DESTINATIONS={HUB_INCHARGE:'/app/overview',RISK_ANALYST:'/app/disruption-intelligence',RECOVERY_MANAGER:'/app/recovery-management',CUSTOMER:'/customer/portal'};
const LOGIN_WINDOW_MS=10*60*1000,MAX_LOGIN_ATTEMPTS=10,LOGIN_BLOCK_MS=10*60*1000;
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
const loginAttempts=new Map();
function send(res,status,body,headers={}){res.writeHead(status,{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https://tile.openstreetmap.org; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",...headers});res.end(body);}
function json(res,status,payload,headers={}){send(res,status,JSON.stringify(payload),{'Content-Type':'application/json; charset=utf-8',...headers});}
function redirect(res,location){send(res,302,'',{Location:location});}
function readBody(req,maxBytes=5*1024*1024){return new Promise((resolve,reject)=>{let chunks=[],size=0;req.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){reject(new Error('Request body is too large.'));req.destroy();return;}chunks.push(chunk);});req.on('end',()=>{const raw=Buffer.concat(chunks).toString('utf8');if(!raw)return resolve({});if((req.headers['content-type']||'').includes('application/json')){try{return resolve(JSON.parse(raw));}catch{return reject(new Error('Invalid JSON body.'));}}resolve({raw,contentType:req.headers['content-type']||'text/plain'});});req.on('error',reject);});}
function safeStatic(requestPath){let pathname;try{pathname=decodeURIComponent(new URL(requestPath,'http://localhost').pathname);}catch{return null;}const rel=pathname.replace(/^\/+/, '');const full=path.resolve(PUBLIC,rel||'app.html');if(full!==PUBLIC&&!full.startsWith(PUBLIC+path.sep))return null;return full;}
function serveFile(file,res){fs.readFile(file,(err,buf)=>{if(err)return send(res,404,'Not found',{'Content-Type':'text/plain; charset=utf-8'});send(res,200,buf,{'Content-Type':MIME[path.extname(file).toLowerCase()]||'application/octet-stream','Last-Modified':fs.statSync(file).mtime.toUTCString()});});}
function sessionUser(req){return getSessionFromRequest(req);}
function requireUser(req,res){const s=sessionUser(req);if(!s){json(res,401,{success:false,error:'Authentication required.'});return null;}return s;}
function requireMutation(req,res,session){if(!verifyCsrf(req,session)){json(res,403,{success:false,error:'CSRF validation failed. Refresh the application and retry.'});return false;}return true;}
function requireRole(req,res,session,...roles){if(!canAccess(session?.user,...roles)){json(res,403,{success:false,error:'You do not have permission to perform this action.'});return false;}return true;}
function requireExactRole(req,res,session,...roles){if(!session?.user||!roles.includes(session.user.role)){json(res,403,{success:false,error:`This action requires ${roles.join(' or ')} permission.`});return false;}return true;}
const INTERNAL_ROLES=new Set(['HUB_INCHARGE','RISK_ANALYST','RECOVERY_MANAGER']);
function userSummary(user){return{id:user.id,username:user.username,email:user.email,name:user.name,role:user.role,initials:user.initials};}
function roleDestination(role){return ROLE_DESTINATIONS[role]||'/login';}
function sameOriginRequest(req){const origin=req.headers.origin;if(!origin)return true;try{return new URL(origin).host===(req.headers.host||'');}catch{return false;}}
function loginThrottle(ip){const now=Date.now();let state=loginAttempts.get(ip);if(state?.blockedUntil>now)return{blocked:true,retryAfter:Math.ceil((state.blockedUntil-now)/1000)};if(!state||now-state.windowStartedAt>LOGIN_WINDOW_MS){state={count:0,windowStartedAt:now,blockedUntil:0};loginAttempts.set(ip,state);}if(state.blockedUntil&&state.blockedUntil<=now){state={count:0,windowStartedAt:now,blockedUntil:0};loginAttempts.set(ip,state);}return{blocked:false,state};}
function recordLoginFailure(ip){const {state}=loginThrottle(ip);state.count+=1;if(state.count>=MAX_LOGIN_ATTEMPTS)state.blockedUntil=Date.now()+LOGIN_BLOCK_MS;}
function authCookieHeaders(session,production){const secure=production?'; Secure':'';return{'Set-Cookie':[`diq_session=${encodeURIComponent(session.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${session.maxAgeSeconds}${secure}`,`diq_csrf=${encodeURIComponent(session.csrf)}; SameSite=Lax; Path=/; Max-Age=${session.maxAgeSeconds}${secure}`]};}
function clearAuthCookieHeaders(production){const secure=production?'; Secure':'';return{'Set-Cookie':[`diq_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,`diq_csrf=; SameSite=Lax; Path=/; Max-Age=0${secure}`]};}
function parseId(value,prefix){const s=String(value||'');const n=prefix&&s.startsWith(prefix)?s.slice(prefix.length):s;const out=Number(n);return Number.isInteger(out)&&out>0?out:null;}
function auditDecision(approvalId,user,decision,comments=''){const approval=get('SELECT * FROM approvals WHERE id=?',approvalId);if(!approval)return{status:404,body:{error:'Approval not found.'}};const plan=get('SELECT * FROM recovery_plans WHERE id=?',approval.recovery_plan_id);if(!plan)return{status:404,body:{error:'Recovery plan not found.'}};const result=reviewPlanApproval(plan.id,user,decision==='approve'?'Approved':'Rejected',comments);return result.ok?{status:200,body:{ok:true,approval:get('SELECT * FROM approvals WHERE id=?',approval.id)}}:{status:400,body:{error:result.message}};}
function getApiCollections(user){return getDashboardData(user);}
function parsePagination(url){return{limit:Math.min(200,Math.max(1,Number(url.searchParams.get('limit')||50))),offset:Math.max(0,Number(url.searchParams.get('offset')||0))};}
function validDateOnly(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(`${value}T00:00:00Z`);return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===value;}
function listDisruptions(url){const {limit,offset}=parsePagination(url);let rows=all('SELECT d.*,s.tracking_number,w.code AS warehouse_code,(SELECT COUNT(DISTINCT x.customer_order_id) FROM disruption_affected_orders x WHERE x.disruption_id=d.id) AS affected_orders FROM disruptions d LEFT JOIN shipments s ON s.id=d.shipment_id LEFT JOIN warehouses w ON w.id=d.warehouse_id ORDER BY d.detected_at DESC');const sev=url.searchParams.get('severity'),status=url.searchParams.get('status'),q=(url.searchParams.get('q')||'').toLowerCase();if(sev)rows=rows.filter(x=>x.severity.toLowerCase()===sev.toLowerCase());if(status)rows=rows.filter(x=>x.status.toLowerCase()===status.toLowerCase());if(q)rows=rows.filter(x=>`${x.disruption_code} ${x.title} ${x.location} ${x.description}`.toLowerCase().includes(q));return{success:true,count:rows.length,disruptions:rows.slice(offset,offset+limit)};}
function errorMessage(err){if(err?.message==='UNIQUE constraint failed: webhook_events.event_identifier')return'Webhook event already processed.';return err?.message||'Unexpected server error.';}
function recordWebhookFailure(eventId,eventType,payload,message){
 const id=String(eventId||'').trim();if(!id||id.length>120)return;
 if(get('SELECT id FROM webhook_events WHERE event_identifier=?',id))return;
 const now=nowIso();db.exec('BEGIN IMMEDIATE');try{run(`INSERT INTO webhook_events(event_identifier,source,event_type,payload_json,processing_status,received_at,processed_at,error_details) VALUES(?,?,?,?,?,?,?,?)`,id,'CarrierAPI_Simulator',String(eventType||'INVALID').slice(0,80),JSON.stringify(payload||{}),'Failed',now,now,String(message||'Validation failed').slice(0,1000));audit({action:'WEBHOOK_REJECTED',entityType:'WebhookEvent',entityId:id,details:String(message||'Validation failed')});db.exec('COMMIT');}catch(e){try{db.exec('ROLLBACK')}catch{}if(!String(e.message||'').includes('UNIQUE constraint'))throw e;}
}
function processCarrierEvent(payload){
 const suppliedEventId=String(payload?.event_id||'').trim();const prior=suppliedEventId?get('SELECT * FROM webhook_events WHERE event_identifier=?',suppliedEventId):null;
 if(prior)return{status:200,body:{success:true,status:'already_processed',message:`Webhook event '${suppliedEventId}' has already been processed idempotently.`,event_id:suppliedEventId,original_processing_status:prior.processing_status,processed_at:prior.processed_at,error_details:prior.error_details||null}};
 const required=['event_id','tracking_number','event_type'];const missing=required.filter(k=>!payload?.[k]);
 if(missing.length){const message=`Missing required payload fields: ${missing.join(', ')}`;recordWebhookFailure(suppliedEventId,payload?.event_type,payload,message);audit({action:'WEBHOOK_REJECTED_INVALID_PAYLOAD',entityType:'WebhookEvent',details:message});return{status:400,body:{success:false,error:message}};}
 const eventId=String(payload.event_id).trim(),tracking=String(payload.tracking_number).trim(),eventType=String(payload.event_type).trim().toUpperCase();
 const allowed=new Set(['SHIPMENT_DELAY','PORT_CONGESTION','WEATHER_ALERT','CUSTOMS_HOLD','STATUS_UPDATE','CARRIER_UPDATE','DELIVERY_CONFIRMATION','LOCATION_UPDATE','CHECKPOINT_UPDATE','TRANSIT_UPDATE','SHIPMENT_DISPATCHED','VEHICLE_ACCIDENT','SHIPMENT_ARRIVED','SHIPMENT_DELIVERED']);
 if(!allowed.has(eventType)){const message=`Unsupported event type '${eventType}'.`;recordWebhookFailure(eventId,eventType,payload,message);audit({action:'WEBHOOK_REJECTED_UNSUPPORTED_TYPE',entityType:'WebhookEvent',details:`Event '${eventId}' has unsupported event type '${eventType}'.`});return{status:400,body:{success:false,error:message}};}
 const validStatuses=new Set(['Scheduled','In Transit','Delayed','Arrived','Delivered','Cancelled']);const status=String(payload.status||'In Transit');
 if(!validStatuses.has(status)){const message=`Invalid shipment status '${status}'.`;recordWebhookFailure(eventId,eventType,payload,message);return{status:400,body:{success:false,error:message}};}
 const delay=Number(payload.delay_hours||0);if(!Number.isFinite(delay)||delay<0||delay>720){const message='delay_hours must be between 0 and 720.';recordWebhookFailure(eventId,eventType,payload,message);return{status:400,body:{success:false,error:message}};}
 let eta=null;if(payload.estimated_arrival){eta=new Date(payload.estimated_arrival);if(Number.isNaN(eta.getTime())){const message=`Invalid estimated_arrival timestamp '${payload.estimated_arrival}'.`;recordWebhookFailure(eventId,eventType,payload,message);return{status:400,body:{success:false,error:message}};}}
 let eventTime=null;if(payload.event_timestamp){eventTime=new Date(payload.event_timestamp);if(Number.isNaN(eventTime.getTime())){const message=`Invalid event_timestamp '${payload.event_timestamp}'.`;recordWebhookFailure(eventId,eventType,payload,message);return{status:400,body:{success:false,error:message}};}if(eventTime.getTime()>Date.now()+5*60*1000){const message='event_timestamp cannot be more than five minutes in the future.';recordWebhookFailure(eventId,eventType,payload,message);return{status:400,body:{success:false,error:message}};}}
 const shipment=get('SELECT * FROM shipments WHERE tracking_number=?',tracking);
 const now=nowIso();
 if(shipment&&eventTime){const priorEvents=all(`SELECT payload_json FROM webhook_events WHERE processing_status='Processed' ORDER BY received_at DESC LIMIT 250`);let latest=null;for(const row of priorEvents){try{const old=JSON.parse(row.payload_json||'{}');if(String(old.tracking_number||'')!==tracking||!old.event_timestamp)continue;const t=new Date(old.event_timestamp);if(!Number.isNaN(t.getTime())&&(!latest||t>latest))latest=t;}catch{}}if(latest&&eventTime<=latest){const message=`Stale event timestamp ${eventTime.toISOString()} is not newer than the latest processed event ${latest.toISOString()}.`;recordWebhookFailure(eventId,eventType,payload,message);return{status:409,body:{success:false,error:message}};}}
 if(!shipment){db.exec('BEGIN IMMEDIATE');try{run(`INSERT INTO webhook_events(event_identifier,source,event_type,payload_json,processing_status,received_at,processed_at,error_details) VALUES(?,?,?,?,?,?,?,?)`,eventId,'CarrierAPI_Simulator',eventType,JSON.stringify(payload),'Failed',now,now,`Unknown shipment reference '${tracking}'.`);audit({action:'WEBHOOK_REJECTED_UNKNOWN_SHIPMENT',entityType:'Shipment',details:`Carrier event '${eventId}' references non-existent shipment '${tracking}'.`});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return{status:404,body:{success:false,error:`Shipment with tracking number '${tracking}' does not exist in DisruptionIQ.`}};}
 if(shipment.status==='Delivered'&&status!=='Delivered'){
  db.exec('BEGIN IMMEDIATE');try{run(`INSERT INTO webhook_events(event_identifier,source,event_type,payload_json,processing_status,received_at,processed_at,error_details) VALUES(?,?,?,?,?,?,?,?)`,eventId,'CarrierAPI_Simulator',eventType,JSON.stringify(payload),'Failed',now,now,`Shipment '${tracking}' has already been delivered.`);audit({action:'WEBHOOK_REJECTED_STALE_UPDATE',entityType:'Shipment',entityId:shipment.id,details:`Carrier event '${eventId}' rejected: Shipment '${tracking}' has already been delivered.`});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return{status:409,body:{success:false,error:`Shipment '${tracking}' has already been delivered. Stale in-transit update rejected.`}};
 }
 db.exec('BEGIN IMMEDIATE');
 try{
  if(eta)run('UPDATE shipments SET estimated_arrival=? WHERE id=?',eta.toISOString(),shipment.id);
  if(payload.location)run('UPDATE shipments SET origin_city=? WHERE id=?',String(payload.location),shipment.id);
  const terminalOrMilestone=['SHIPMENT_DISPATCHED','SHIPMENT_ARRIVED','SHIPMENT_DELIVERED'].includes(eventType);const delayEvent=status!=='Delivered'&&!terminalOrMilestone&&(status==='Delayed'||delay>0||['SHIPMENT_DELAY','PORT_CONGESTION','WEATHER_ALERT','CUSTOMS_HOLD','VEHICLE_ACCIDENT'].includes(eventType));
  let disruptionInfo=null;
  if(delayEvent){run("UPDATE shipments SET status='Delayed' WHERE id=?",shipment.id);const d=evaluateAndRecordShipmentDisruption(shipment.id,delay>0?delay:48,`[${eventType}] ${payload.reason||`Carrier reported disruption at ${payload.location||'checkpoint'}.`}`);const count=Number(get('SELECT COUNT(*) AS n FROM disruption_affected_orders WHERE disruption_id=?',d.id).n||0);disruptionInfo={disruption_code:d.disruption_code,severity:d.severity,shortage_category:d.shortage_category,affected_orders_count:count};}
  else if(status==='Delivered'||eventType==='SHIPMENT_DELIVERED'){run("UPDATE shipments SET status='Delivered',actual_arrival=? WHERE id=?",eventTime?eventTime.toISOString():now,shipment.id);run("UPDATE disruptions SET status='Resolved',resolved_at=? WHERE shipment_id=? AND status='Active'",now,shipment.id);}
  else if(eventType==='SHIPMENT_DISPATCHED')run("UPDATE shipments SET status='In Transit',actual_departure=COALESCE(actual_departure,?) WHERE id=?",eventTime?eventTime.toISOString():now,shipment.id);
  else if(eventType==='SHIPMENT_ARRIVED')run("UPDATE shipments SET status='Arrived',actual_arrival=COALESCE(actual_arrival,?) WHERE id=?",eventTime?eventTime.toISOString():now,shipment.id);
  else if(status!=='In Transit')run('UPDATE shipments SET status=? WHERE id=?',status,shipment.id);
  run(`INSERT INTO webhook_events(event_identifier,source,event_type,payload_json,processing_status,received_at,processed_at) VALUES(?,?,?,?,?,?,?)`,eventId,'CarrierAPI_Simulator',eventType,JSON.stringify(payload),'Processed',now,now);
  const updated=get('SELECT * FROM shipments WHERE id=?',shipment.id);audit({action:`WEBHOOK_${eventType}`,entityType:'Shipment',entityId:shipment.id,details:`Processed simulated carrier event '${eventId}' for ${tracking}. Status: ${updated.status}. Delay: ${delay}h. Event time: ${eventTime?eventTime.toISOString():'not supplied'}.`});
  db.exec('COMMIT');
  return{status:201,body:{success:true,message:`Carrier event '${eventId}' processed successfully.`,event_id:eventId,shipment:{tracking_number:updated.tracking_number,status:updated.status,carrier:updated.carrier,estimated_arrival:updated.estimated_arrival},disruption:disruptionInfo}};
 }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
}

const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,`http://${req.headers.host||'localhost'}`),p=url.pathname;
 try{
  // Public health and authenticated application routes (five primary pages plus backward-compatible module routes).
  if(req.method==='GET'&&p==='/health')return json(res,200,{ok:true,service:'DisruptionIQ Node API',version:'7.1.0',runtime:process.version,database:'SQLite',mode:process.env.NODE_ENV||'development'});
  if(req.method==='GET'&&p==='/')return redirect(res,'/login');
  if(req.method==='GET'&&p==='/login'){const s=sessionUser(req);if(s)return redirect(res,roleDestination(s.user.role));return serveFile(path.join(PUBLIC,'login.html'),res);}
  if(req.method==='GET'&&(p==='/customer'||p==='/customer/portal')){const s=sessionUser(req);if(!s)return redirect(res,'/login');if(s.user.role!=='CUSTOMER')return redirect(res,'/app/overview');if(!s.user.customer_id)return send(res,403,'Customer account is not linked to a customer record.',{'Content-Type':'text/plain; charset=utf-8'});return serveFile(path.join(PUBLIC,'customer.html'),res);}
  if(req.method==='GET'&&(p==='/app'||p.startsWith('/app/'))){const s=sessionUser(req);if(!s)return redirect(res,'/login');if(s.user.role==='CUSTOMER')return send(res,403,'This workspace is available to employees only.',{'Content-Type':'text/plain; charset=utf-8'});const page=p.split('/')[2]||'overview';const internal=['HUB_INCHARGE','RISK_ANALYST','RECOVERY_MANAGER'];const pageRoles={'overview':internal,'network-operations':internal,'hub-overview':internal,'hub-details':internal,'shipments':internal,'suppliers':internal,'warehouses':internal,'orders':internal,'disruption-intelligence':['HUB_INCHARGE','RISK_ANALYST','RECOVERY_MANAGER'],'risk':['HUB_INCHARGE','RISK_ANALYST','RECOVERY_MANAGER'],'recovery-management':['HUB_INCHARGE','RECOVERY_MANAGER'],'recovery':['HUB_INCHARGE','RECOVERY_MANAGER'],'intelligence-administration':['HUB_INCHARGE','RECOVERY_MANAGER'],'audit':['HUB_INCHARGE','RECOVERY_MANAGER']};if(!pageRoles[page])return send(res,404,'Page not found',{'Content-Type':'text/plain; charset=utf-8'});if(!pageRoles[page].includes(s.user.role))return send(res,403,'Your role does not have access to this workspace.',{'Content-Type':'text/plain; charset=utf-8'});return serveFile(path.join(PUBLIC,'app.html'),res);}

  // Authentication routes retain legacy aliases while exposing the versioned API contract.
  if(req.method==='POST'&&(p==='/api/auth/login'||p==='/api/v1/auth/login')){
   if(!sameOriginRequest(req))return json(res,403,{success:false,ok:false,error:'Sign-in request origin is not allowed.'});
   if(!(req.headers['content-type']||'').toLowerCase().includes('application/json'))return json(res,415,{success:false,ok:false,error:'Sign-in requires an application/json request.'});
   let b;try{b=await readBody(req,32*1024);}catch{return json(res,400,{success:false,ok:false,error:'The sign-in request is invalid.'});}
   const email=typeof b.email==='string'?b.email.trim().toLowerCase():'';const password=typeof b.password==='string'?b.password:'';
   if(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!password||password.length>1024)return json(res,400,{success:false,ok:false,error:'Enter a valid email address and password.'});
   const ip=req.socket.remoteAddress||'unknown';const throttle=loginThrottle(ip);if(throttle.blocked)return json(res,429,{success:false,ok:false,error:'Too many sign-in attempts. Please wait before trying again.',retry_after_seconds:throttle.retryAfter},{'Retry-After':String(throttle.retryAfter)});
   const user=get('SELECT * FROM users WHERE lower(email)=?',email);
   if(!user||user.is_active!==1||!AUTH_ROLES.includes(user.role)||!verifyPassword(password,user.password_hash)){recordLoginFailure(ip);return json(res,401,{success:false,ok:false,error:'Email or password did not match a DisruptionIQ account.'});}
   // Rotate any existing browser session before issuing a fresh, unpredictable token.
   destroySession(req);const remember=b.remember===true;const session=createSession(user.id,{remember});run('UPDATE users SET last_login=? WHERE id=?',nowIso(),user.id);audit({userId:user.id,action:'LOGIN',entityType:'User',entityId:user.id,ip,details:`${user.username} signed in.`});loginAttempts.delete(ip);
   const userInfo={id:user.id,username:user.username,email:user.email,name:user.full_name||user.username,initials:(user.full_name||user.username).split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase(),role:user.role};
   return json(res,200,{success:true,ok:true,authenticated:true,user:userInfo,redirect_to:roleDestination(user.role),session:{expires_at:session.expires}},authCookieHeaders(session,process.env.NODE_ENV==='production'));
  }
  if(req.method==='GET'&&(p==='/api/auth/me'||p==='/api/v1/auth/me')){
   const s=requireUser(req,res);if(!s)return;return json(res,200,{success:true,authenticated:true,user:userSummary(s.user),redirect_to:roleDestination(s.user.role),session:{expires_at:s.expires}});
  }
  if(req.method==='POST'&&(p==='/api/auth/logout'||p==='/api/v1/auth/logout')){
   const s=requireUser(req,res);if(!s)return;if(!requireMutation(req,res,s))return;destroySession(req);audit({userId:s.user.id,action:'LOGOUT',entityType:'User',entityId:s.user.id,details:'User signed out.'});return json(res,200,{success:true,ok:true,authenticated:false},clearAuthCookieHeaders(process.env.NODE_ENV==='production'));
  }

  if(p.startsWith('/api/v1/customer/')){
   const s=requireUser(req,res);if(!s)return;const user=s.user;
   if(user.role!=='CUSTOMER'||!user.customer_id)return json(res,403,{success:false,error:'Customer access is not authorized.'});
   if(req.method==='GET'&&p==='/api/v1/customer/dashboard'){
    const summary=get(`SELECT COUNT(*) AS total_orders,SUM(CASE WHEN lower(status) NOT IN ('delivered','cancelled') THEN 1 ELSE 0 END) AS active_orders,SUM(CASE WHEN lower(status)='delivered' THEN 1 ELSE 0 END) AS delivered_orders,SUM(CASE WHEN lower(status)='at risk' THEN 1 ELSE 0 END) AS attention_orders FROM customer_orders WHERE customer_id=?`,user.customer_id)||{};
    const notifications=all('SELECT id,title,message,category,is_read,created_at,customer_order_id,disruption_id FROM notifications WHERE recipient_user_id=? ORDER BY created_at DESC LIMIT 20',user.id);
    return json(res,200,{success:true,summary:Object.fromEntries(Object.entries(summary).map(([k,v])=>[k,Number(v||0)])),notifications});
   }
   if(req.method==='GET'&&p==='/api/v1/customer/orders'){
    const orders=all(`SELECT o.id,o.order_number,o.customer_name,o.status,o.priority,o.total_value,o.order_date,o.delivery_deadline,w.code AS warehouse_code FROM customer_orders o LEFT JOIN warehouses w ON w.id=o.assigned_warehouse_id WHERE o.customer_id=? ORDER BY o.order_date DESC`,user.customer_id);
    return json(res,200,{success:true,count:orders.length,orders});
   }
   const customerOrderMatch=p.match(/^\/api\/v1\/customer\/orders\/(\d+)$/);
   if(req.method==='GET'&&customerOrderMatch){
    const order=get(`SELECT o.id,o.order_number,o.customer_name,o.status,o.priority,o.total_value,o.order_date,o.delivery_deadline,w.code AS warehouse_code FROM customer_orders o LEFT JOIN warehouses w ON w.id=o.assigned_warehouse_id WHERE o.id=? AND o.customer_id=?`,Number(customerOrderMatch[1]),user.customer_id);
    if(!order)return json(res,404,{success:false,error:'Order not found.'});
    const items=all('SELECT sku,item_name,quantity,unit_price FROM order_items WHERE order_id=?',order.id);
    const disruptions=all(`SELECT d.id,d.disruption_code,d.title,d.disruption_type,d.severity,d.status,d.description,d.detected_at FROM disruption_affected_orders x JOIN disruptions d ON d.id=x.disruption_id WHERE x.customer_order_id=? ORDER BY d.detected_at DESC`,order.id);
    const recovery=all(`SELECT p.id,p.plan_code,p.title,p.strategy_type,p.status,p.progress,p.created_at,p.executed_at FROM recovery_plans p JOIN disruption_affected_orders x ON x.disruption_id=p.disruption_id WHERE x.customer_order_id=? AND p.status IN ('Approved','Executed','Execution Failed') ORDER BY p.created_at DESC`,order.id);
    const shipments=all(`SELECT DISTINCT s.id,s.tracking_number,s.status,s.carrier,s.origin_city,s.destination_city,s.estimated_arrival,s.actual_arrival FROM disruption_affected_orders x JOIN disruptions d ON d.id=x.disruption_id JOIN shipments s ON s.id=d.shipment_id WHERE x.customer_order_id=?`,order.id);
    const notifications=all('SELECT id,title,message,category,is_read,created_at FROM notifications WHERE recipient_user_id=? AND customer_order_id=? ORDER BY created_at DESC',user.id,order.id);
    return json(res,200,{success:true,order:{...order,items,disruptions,recovery,shipments,notifications}});
   }
   if(req.method==='GET'&&p==='/api/v1/customer/notifications'){
    const notifications=all('SELECT id,title,message,category,is_read,created_at,customer_order_id,disruption_id FROM notifications WHERE recipient_user_id=? ORDER BY created_at DESC LIMIT 100',user.id);
    return json(res,200,{success:true,count:notifications.length,notifications});
   }
   const customerRead=p.match(/^\/api\/v1\/customer\/notifications\/(\d+)\/read$/);
   if(req.method==='POST'&&customerRead){if(!requireMutation(req,res,s))return;run('UPDATE notifications SET is_read=1 WHERE id=? AND recipient_user_id=?',Number(customerRead[1]),user.id);return json(res,200,{success:true});}
   return json(res,404,{success:false,error:'Customer API route not found.'});
  }

  if(p.startsWith('/api/')&&p!=='/api/webhooks/carrier'){
   const s=requireUser(req,res);if(!s)return;const user=s.user;
   if(!INTERNAL_ROLES.has(user.role))return json(res,403,{success:false,error:'Customer accounts cannot access employee operations APIs.'});
   if(req.method==='GET'&&p==='/api/me')return json(res,200,{user:{id:user.id,name:user.name,initials:user.initials,username:user.username,email:user.email,role:user.role}});
   if(req.method==='GET'&&p==='/api/profile')return json(res,200,{success:true,user:userSummary(user),roles:ROLES});
   if(req.method==='GET'&&p==='/api/data')return json(res,200,getApiCollections(user));
   if(req.method==='GET'&&p==='/api/v1/disruptions')return json(res,200,listDisruptions(url));
   let impactMatch=p.match(/^\/api\/v1\/disruptions\/(\d+)\/impact$/);
   if(req.method==='GET'&&impactMatch){const result=analyzeDisruptionImpact(Number(impactMatch[1]));if(result.error)return json(res,404,{success:false,error:result.error});const recovery_plans=all(`SELECT id,plan_code,title,strategy_type,status,created_at,executed_at FROM recovery_plans WHERE disruption_id=? ORDER BY created_at DESC`,Number(impactMatch[1]));return json(res,200,{success:true,data:{...result,recovery_plans}});}
   if(req.method==='POST'&&p==='/api/v1/webhooks/simulate'){
    if(!requireMutation(req,res,s))return;const b=await readBody(req,16*1024);const eventId=String(b.event_id||`SIM-WEBHOOK-${crypto.randomUUID()}`).trim();if(!eventId||eventId.length>120)return json(res,400,{success:false,error:'event_id must contain 1 to 120 characters.'});const shipmentId=Number(b.shipment_id);const shipment=Number.isSafeInteger(shipmentId)&&shipmentId>0?get('SELECT * FROM shipments WHERE id=?',shipmentId):null;
    const eventType=String(b.event_type||'').toUpperCase(),delay=Number(b.delay_hours??0);const result=processCarrierEvent({event_id:eventId,tracking_number:shipment?.tracking_number||String(b.tracking_number||''),event_type:eventType,status:String(b.status||'Delayed'),delay_hours:delay,reason:String(b.reason||'Simulated carrier webhook').slice(0,500),location:String(b.location||shipment?.destination_city||'').slice(0,120),event_timestamp:b.event_timestamp});
    if(result.status>=400)return json(res,result.status,{success:false,simulated:true,event_id:eventId,source:'CarrierAPI_Simulator',...result.body});if(result.body?.status==='already_processed')return json(res,200,{success:true,simulated:true,duplicate:true,event_id:eventId,source:'CarrierAPI_Simulator',...result.body});audit({userId:user.id,action:'SIMULATED_CARRIER_WEBHOOK',entityType:'Shipment',entityId:shipment?.id||null,details:`${eventId} · ${eventType} · ${shipment?.tracking_number||b.tracking_number||'missing shipment reference'}`});
    return json(res,result.status,{success:true,simulated:true,event_id:eventId,source:'CarrierAPI_Simulator',...result.body});
   }
   if(req.method==='GET'&&p==='/api/v1/scenarios'){
    const shipments=all(`SELECT s.id,s.tracking_number,s.status,s.carrier,s.origin_city,s.destination_city,s.supplier_id,s.destination_warehouse_id,sp.name AS supplier_name FROM shipments s LEFT JOIN suppliers sp ON sp.id=s.supplier_id WHERE s.status<>'Delivered' ORDER BY s.id LIMIT 100`);
    const suppliers=all('SELECT id,code,name FROM suppliers WHERE is_active=1 ORDER BY name LIMIT 100');
    const warehouses=all('SELECT id,code,name FROM warehouses WHERE is_active=1 ORDER BY code LIMIT 100');
    return json(res,200,{success:true,warehouses,scenarios:[{type:'ROAD_ACCIDENT',label:'Road accident',event_type:'SHIPMENT_DELAY',delay_hours:48,description:'Simulated vehicle accident affecting a selected shipment.'},{type:'SEVERE_WEATHER',label:'Severe weather',event_type:'WEATHER_ALERT',delay_hours:36,description:'Simulated severe weather interruption.'},{type:'SUPPLIER_DELAY',label:'Supplier delay',event_type:'SHIPMENT_DELAY',delay_hours:72,description:'Simulated supplier-linked inbound delay.'}],shipments,suppliers});
   }
   if(req.method==='POST'&&p==='/api/v1/scenarios/trigger'){
    if(!requireMutation(req,res,s))return;if(!requireExactRole(req,res,s,'RISK_ANALYST','HUB_INCHARGE','RECOVERY_MANAGER'))return;
    const b=await readBody(req,32*1024);const kind=String(b.type||'').toUpperCase();const allowed=['ROAD_ACCIDENT','SEVERE_WEATHER','SUPPLIER_DELAY'];
    if(!allowed.includes(kind))return json(res,400,{success:false,error:'Choose a supported scenario type.'});
    const shipmentId=Number(b.shipment_id);if(!Number.isInteger(shipmentId)||shipmentId<1)return json(res,400,{success:false,error:'Select a valid shipment.'});
    const shipment=get('SELECT * FROM shipments WHERE id=?',shipmentId);if(!shipment)return json(res,404,{success:false,error:'Shipment not found.'});
    if(shipment.status==='Delivered')return json(res,409,{success:false,error:'A delivered shipment cannot be disrupted.'});
    if(kind==='SUPPLIER_DELAY'&&!shipment.supplier_id)return json(res,400,{success:false,error:'Selected shipment has no verified supplier relationship.'});
    const eventId=String(b.event_id||`SIM-${kind}-${crypto.randomUUID()}`).slice(0,120);const existing=get('SELECT * FROM webhook_events WHERE event_identifier=?',eventId);
    if(existing)return json(res,200,{success:true,duplicate:true,event_id:eventId,message:'This simulated event was already processed.'});
    const scenario={ROAD_ACCIDENT:{event:'SHIPMENT_DELAY',delay:48,reason:'SIMULATED EVENT: Road accident scenario. Damage status is not asserted.'},SEVERE_WEATHER:{event:'WEATHER_ALERT',delay:36,reason:'SIMULATED EVENT: Severe weather interruption. Route feasibility is not asserted.'},SUPPLIER_DELAY:{event:'SHIPMENT_DELAY',delay:72,reason:'SIMULATED EVENT: Supplier delay for the shipment’s verified supplier.'}}[kind];
    const result=processCarrierEvent({event_id:eventId,tracking_number:shipment.tracking_number,event_type:scenario.event,status:'Delayed',delay_hours:scenario.delay,reason:scenario.reason,location:shipment.destination_city||'Recorded destination'});
    if(result.status>=400)return json(res,result.status,result.body);
    const disruption=get("SELECT * FROM disruptions WHERE shipment_id=? AND status IN ('Active','Investigating') ORDER BY detected_at DESC LIMIT 1",shipment.id);
    db.exec('BEGIN IMMEDIATE');try{if(disruption){run("UPDATE disruptions SET title=?,disruption_type=?,description=?,data_origin='synthetic' WHERE id=?",`${kind.replaceAll('_',' ')} · ${shipment.tracking_number}`,kind,scenario.reason,disruption.id);audit({userId:user.id,action:'TRIGGER_SIMULATED_DISRUPTION',entityType:'Disruption',entityId:disruption.id,details:`${kind} event ${eventId}; shipment ${shipment.tracking_number}.`});}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    const impact=disruption?analyzeDisruptionImpact(disruption.id):null;
    return json(res,201,{success:true,simulated:true,event_id:eventId,scenario:kind,shipment:{id:shipment.id,tracking_number:shipment.tracking_number},disruption,impact,message:'Simulated event persisted. Review the verified impact before creating a recovery plan.'});
   }
   if(req.method==='POST'&&p==='/api/v1/customer-updates'){
    if(!requireMutation(req,res,s))return;const b=await readBody(req,32*1024);const disruptionId=Number(b.disruption_id);const orderId=Number(b.order_id);const recoveryPlanId=Number(b.recovery_plan_id);const message=String(b.message||'').trim();
    if(!Number.isInteger(disruptionId)||!Number.isInteger(orderId)||!Number.isInteger(recoveryPlanId)||!message||message.length>1200)return json(res,400,{success:false,error:'A valid disruption, affected order, approved recovery plan and message (max 1200 characters) are required.'});
    if(b.approved_for_customer!==true)return json(res,400,{success:false,error:'Confirm that this message contains verified information approved for customer disclosure.'});
    let notificationId=null,linkedOrder=null,approvedPlan=null;
    try{db.exec('BEGIN IMMEDIATE');linkedOrder=get('SELECT o.id,o.customer_id,o.order_number FROM customer_orders o JOIN disruption_affected_orders x ON x.customer_order_id=o.id WHERE o.id=? AND x.disruption_id=?',orderId,disruptionId);if(!linkedOrder)throw new Error('The selected order is not verified as affected by this disruption.');
     approvedPlan=get(`SELECT id,plan_code,title,status FROM recovery_plans WHERE id=? AND disruption_id=? AND status IN ('Approved','Executed')`,recoveryPlanId,disruptionId);if(!approvedPlan)throw new Error('The selected recovery plan is not linked to this disruption or has not been approved.');
     const customerUsers=all("SELECT id FROM users WHERE customer_id=? AND role='CUSTOMER' AND is_active=1",linkedOrder.customer_id);if(!customerUsers.length)throw new Error('No active customer portal account is linked to this order.');
     const now=nowIso();for(const customerUser of customerUsers){const r=run(`INSERT INTO notifications(recipient_role,recipient_user_id,title,message,category,is_read,created_at,customer_order_id,disruption_id,recovery_plan_id,data_origin) VALUES('CUSTOMER',?,?,?,'Recovery',0,?,?,?,?, 'operational')`,customerUser.id,`Recovery update for ${linkedOrder.order_number}`,message,now,orderId,disruptionId,approvedPlan.id);notificationId=Number(r.lastInsertRowid);}
     audit({userId:user.id,action:'CUSTOMER_DISRUPTION_UPDATE_SENT',entityType:'Notification',entityId:notificationId,details:`Customer update linked to order ${linkedOrder.order_number}, disruption ${disruptionId} and approved recovery plan ${approvedPlan.plan_code}.`});db.exec('COMMIT');
    }catch(e){try{db.exec('ROLLBACK')}catch{}return json(res,e.message.includes('not verified')?400:409,{success:false,error:e.message});}
    return json(res,201,{success:true,notification:get('SELECT id,title,message,category,created_at,customer_order_id,disruption_id,recovery_plan_id FROM notifications WHERE id=?',notificationId)});
   }

   if(req.method==='GET'&&p==='/api/dashboard-charts')return json(res,200,{success:true,data:getDashboardSummary(user)});

   // Original frontend actions, now backed by SQLite and audited.
   let m=p.match(/^\/api\/incidents\/([^/]+)\/acknowledge$/);
   if(req.method==='POST'&&m){if(!requireMutation(req,res,s))return;const code=decodeURIComponent(m[1]);const d=get('SELECT * FROM disruptions WHERE disruption_code=?',code);if(!d)return json(res,404,{error:'Incident not found.'});if(d.status==='Resolved'||d.status==='Mitigated')return json(res,200,{ok:true,incident:d,unchanged:true});run("UPDATE disruptions SET status='Mitigated' WHERE id=?",d.id);audit({userId:user.id,action:'ACKNOWLEDGE_DISRUPTION',entityType:'Disruption',entityId:d.id,details:`Acknowledged ${d.disruption_code}.`});return json(res,200,{ok:true,incident:get('SELECT * FROM disruptions WHERE id=?',d.id)});}
   m=p.match(/^\/api\/approvals\/([^/]+)\/decision$/);
   if(req.method==='POST'&&m){if(!requireMutation(req,res,s))return;if(!requireExactRole(req,res,s,'RECOVERY_MANAGER'))return;const approvalId=parseId(decodeURIComponent(m[1]),'APR-');const b=await readBody(req,32*1024);if(!['approve','reject'].includes(b.decision))return json(res,400,{error:'Decision must be approve or reject.'});const result=auditDecision(approvalId,user,b.decision,String(b.comments||''));return json(res,result.status,result.body);}
   if(req.method==='POST'&&p==='/api/recovery'){if(!requireMutation(req,res,s))return;if(!requireExactRole(req,res,s,'HUB_INCHARGE'))return;const b=await readBody(req,32*1024);const title=String(b.title||'').trim();if(!title)return json(res,400,{error:'Recovery action title is required.'});const d=get("SELECT * FROM disruptions WHERE status IN ('Active','Investigating') ORDER BY CASE severity WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 ELSE 2 END LIMIT 1");if(!d)return json(res,400,{error:'No active disruption is available to attach this recovery action.'});const code=`REC-${d.disruption_code.slice(-7)}-${Date.now().toString().slice(-6)}`;const now=nowIso();const r=run(`INSERT INTO recovery_plans(plan_code,disruption_id,title,strategy_type,status,quantity,estimated_cost,description,version,created_by_id,created_at,updated_at,protected_value,priority,progress,data_origin) VALUES(?,?,?,'Order Reprioritisation','Draft',1,0,?,1,?,?,?,0,'Medium',0,'operational')`,code,d.id,title,title,user.id,now,now);const id=Number(r.lastInsertRowid);run(`INSERT INTO recovery_actions(recovery_plan_id,action_sequence,action_type,description,status,cost,assigned_to_role,data_origin) VALUES(?,1,'GENERAL_ACTION',?,'Pending',0,'HUB_INCHARGE','operational')`,id,title);audit({userId:user.id,action:'CREATE_RECOVERY_PLAN',entityType:'RecoveryPlan',entityId:id,details:`Created draft ${code}.`});return json(res,201,{ok:true,plan:get('SELECT * FROM recovery_plans WHERE id=?',id)});}

   // Page 05: Hub Overview & Monitoring. All hub records are warehouse-backed.
   if(req.method==='GET'&&p==='/api/v1/hubs/overview')return json(res,200,getHubOverview());
   if(req.method==='GET'&&p==='/api/v1/hubs'){
    const page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||25);
    if(!Number.isInteger(page)||page<1||!Number.isInteger(limit)||limit<1||limit>100)return json(res,400,{success:false,error:'page must be a positive integer and limit must be between 1 and 100.'});
    const filters={q:url.searchParams.get('q')||'',status:url.searchParams.get('status')||'',health:url.searchParams.get('health')||'',disruption:url.searchParams.get('disruption')||'',page,limit};
    if((filters.q||'').length>100)return json(res,400,{success:false,error:'q must be 100 characters or fewer.'});
    if(filters.status&&!['active','inactive'].includes(filters.status.toLowerCase()))return json(res,400,{success:false,error:'status must be active or inactive.'});
    if(filters.health&&!['healthy','watch','critical'].includes(filters.health.toLowerCase()))return json(res,400,{success:false,error:'health must be healthy, watch or critical.'});
    if(filters.disruption&&!['active','none'].includes(filters.disruption.toLowerCase()))return json(res,400,{success:false,error:'disruption must be active or none.'});
    return json(res,200,listHubs(filters));
   }
   let hubMatch=p.match(/^\/api\/v1\/hubs\/(\d+)\/(shipments|disruptions|inventory|orders|recovery|activities)$/);
   if(req.method==='GET'&&hubMatch){
    const id=Number(hubMatch[1]),type=hubMatch[2],page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||25),q=url.searchParams.get('q')||'',status=url.searchParams.get('status')||'';
    if(!Number.isSafeInteger(id)||id<1)return json(res,400,{success:false,error:'Hub ID must be a positive integer.'});
    if(!Number.isInteger(page)||page<1||!Number.isInteger(limit)||limit<1||limit>100)return json(res,400,{success:false,error:'page must be positive and limit must be between 1 and 100.'});
    if(q.length>100)return json(res,400,{success:false,error:'q must be 100 characters or fewer.'});
    if(status.length>40)return json(res,400,{success:false,error:'status must be 40 characters or fewer.'});
    const result=getHubCollection(id,type,{page,limit,q,status});if(!result)return json(res,404,{success:false,error:'Hub not found.'});if(type==='activities')result.activities=result.items;return json(res,200,result);
   }
   hubMatch=p.match(/^\/api\/v1\/hubs\/(\d+)$/);
   if(req.method==='GET'&&hubMatch){const id=Number(hubMatch[1]),hub=getHubDetails(id);return json(res,hub?200:404,hub?{success:true,hub}:{success:false,error:'Hub not found.'});}

   // Dashboard APIs.
   if(req.method==='GET'&&['/api/v1/dashboard','/api/v1/dashboard/summary'].includes(p)){const days=Number(url.searchParams.get('days')||7);const dashboard=getDashboardData(user,{days});return json(res,200,{success:true,data:dashboard,summary:dashboard.overview,last_updated:dashboard.last_updated});}
   // Page 07: database-backed shipment management.
   if(req.method==='GET'&&p==='/api/v1/shipments/overview')return json(res,200,shipmentOverview());
   if(req.method==='GET'&&p==='/api/v1/shipments/geography')return json(res,200,shipmentGeography());
   if(req.method==='GET'&&p==='/api/v1/shipments'){
    const page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||25);
    if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||limit<1||limit>100)return json(res,400,{success:false,error:'page must be a positive integer and limit must be between 1 and 100.'});
    const q=url.searchParams.get('q')||'',status=url.searchParams.get('status')||'',carrier=url.searchParams.get('carrier')||'',originRaw=url.searchParams.get('origin')||'',destinationRaw=url.searchParams.get('destination')||'',from=url.searchParams.get('from')||'',to=url.searchParams.get('to')||'',disruption=url.searchParams.get('disruption')||'',sort=url.searchParams.get('sort')||'created',direction=url.searchParams.get('direction')||'desc';
    if(q.length>100||carrier.length>120)return json(res,400,{success:false,error:'Search and carrier filters exceed their allowed length.'});
    const statuses=all('SELECT DISTINCT status FROM shipments').map(x=>x.status);
    if(status&&!statuses.includes(status))return json(res,400,{success:false,error:'Unsupported shipment status filter.'});
    if(!['','yes','no'].includes(disruption))return json(res,400,{success:false,error:'disruption must be yes or no.'});
    if(!['created','id','tracking','status','eta'].includes(sort)||!['asc','desc'].includes(direction))return json(res,400,{success:false,error:'Invalid sorting options.'});
    const origin=originRaw?Number(originRaw):0,destination=destinationRaw?Number(destinationRaw):0;
    if(originRaw&&(!Number.isSafeInteger(origin)||origin<1||!get('SELECT id FROM warehouses WHERE id=?',origin)))return json(res,400,{success:false,error:'Invalid origin warehouse filter.'});
    if(destinationRaw&&(!Number.isSafeInteger(destination)||destination<1||!get('SELECT id FROM warehouses WHERE id=?',destination)))return json(res,400,{success:false,error:'Invalid destination warehouse filter.'});
    if(from&&!validDateOnly(from)||to&&!validDateOnly(to)||from&&to&&from>to)return json(res,400,{success:false,error:'Date filters must be valid YYYY-MM-DD dates with from not after to.'});
    const carriers=all('SELECT DISTINCT COALESCE(c.name,s.carrier) name FROM shipments s LEFT JOIN carriers c ON c.carrier_code=s.carrier_code').map(x=>x.name).filter(Boolean);
    if(carrier&&!carriers.includes(carrier))return json(res,400,{success:false,error:'Unknown carrier filter.'});
    return json(res,200,shipmentList({page,limit,q,status,carrier,origin,destination,from,to,disruption,sort,direction}));
   }
   let shipmentMatch=p.match(/^\/api\/v1\/shipments\/([^/]+)(?:\/(items|disruptions|recovery|activities))?$/);
   if(req.method==='GET'&&shipmentMatch){
    const raw=shipmentMatch[1],id=Number(raw);if(!/^\d+$/.test(raw)||!Number.isSafeInteger(id)||id<1)return json(res,400,{success:false,error:'Shipment ID must be a positive integer.'});
    const type=shipmentMatch[2];if(!type){const detail=shipmentDetail(id);return json(res,detail?200:404,detail||{success:false,error:'Shipment not found.'});}
    const page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||25);if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||limit<1||limit>100)return json(res,400,{success:false,error:'page must be positive and limit must be between 1 and 100.'});
    const result=shipmentCollection(id,type,{page,limit});return json(res,result?200:404,result||{success:false,error:'Shipment not found.'});
   }
   // Page 08: Supplier Management. Every supplier endpoint is Hub In-Charge only.
   if(p==='/api/v1/suppliers'&&req.method==='GET'){
    if(!requireRole(req,res,s,'HUB_INCHARGE'))return;
    const page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||25),q=url.searchParams.get('q')||'',status=url.searchParams.get('status')||'',products=url.searchParams.get('products')||'',disruption=url.searchParams.get('disruption')||'',activity=url.searchParams.get('activity')||'',sort=url.searchParams.get('sort')||'name',direction=url.searchParams.get('direction')||'asc';
    if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||limit<1||limit>100)return json(res,400,{success:false,error:'page must be positive and limit must be between 1 and 100.'});
    if(q.length>100||status.length>20)return json(res,400,{success:false,error:'Search must be 100 characters or fewer and status 20 characters or fewer.'});
    if(status&&!['active','inactive'].includes(status))return json(res,400,{success:false,error:'status must be active or inactive.'});
    if((products&&!['yes','no'].includes(products))||(disruption&&!['yes','no'].includes(disruption))||(activity&&!['yes','no'].includes(activity)))return json(res,400,{success:false,error:'Relationship filters must be yes or no.'});
    if(!['id','name','code','shipments','products','status'].includes(sort)||!['asc','desc'].includes(direction))return json(res,400,{success:false,error:'Invalid supplier sorting options.'});
    return json(res,200,supplierList({page,limit,q,status,products,disruption,activity,sort,direction}));
   }
   if(req.method==='GET'&&p==='/api/v1/suppliers/overview'){if(!requireRole(req,res,s,'HUB_INCHARGE'))return;return json(res,200,supplierOverview());}
   const supplierMatch=p.match(/^\/api\/v1\/suppliers\/([^/]+)(?:\/(products|shipments|disruptions|recovery|activities))?$/);
   if(req.method==='GET'&&supplierMatch){
    if(!requireRole(req,res,s,'HUB_INCHARGE'))return;
    const raw=supplierMatch[1];if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<1)return json(res,400,{success:false,error:'Supplier ID must be a positive integer.'});
    const id=Number(raw),type=supplierMatch[2];
    if(!type){const result=supplierDetail(id);return json(res,result?200:404,result||{success:false,error:'Supplier not found.'});}
    const page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||25),q=url.searchParams.get('q')||'';
    if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||limit<1||limit>100)return json(res,400,{success:false,error:'page must be positive and limit must be between 1 and 100.'});
    if(q.length>100)return json(res,400,{success:false,error:'q must be 100 characters or fewer.'});
    const result=supplierCollection(id,type,{page,limit,q});return json(res,result?200:404,result||{success:false,error:'Supplier not found.'});
   }
   // Page 09: warehouse and inventory management. Internal read-only APIs.
   if(req.method==='GET'&&p==='/api/v1/inventory/overview'){if(!requireRole(req,res,s,'HUB_INCHARGE'))return;return json(res,200,inventoryOverview());}
   if(req.method==='GET'&&p==='/api/v1/warehouses'){
    if(!requireRole(req,res,s,'HUB_INCHARGE'))return;
    const page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||25),q=url.searchParams.get('q')||'',status=url.searchParams.get('status')||'',location=url.searchParams.get('location')||'',disruption=url.searchParams.get('disruption')||'',sort=url.searchParams.get('sort')||'code',direction=url.searchParams.get('direction')||'asc';
    if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||limit<1||limit>100)return json(res,400,{success:false,error:'page must be positive and limit must be between 1 and 100.'});
    if(q.length>100||location.length>100)return json(res,400,{success:false,error:'Search filters must be 100 characters or fewer.'});
    if(status&&!['active','inactive'].includes(status.toLowerCase()))return json(res,400,{success:false,error:'status must be active or inactive.'});
    if(!['','yes','no'].includes(disruption)||!['code','name','id','status','inventory','shipments'].includes(sort)||!['asc','desc'].includes(direction))return json(res,400,{success:false,error:'Invalid warehouse filter or sorting option.'});
    return json(res,200,warehouseList({page,limit,q,status:status.toLowerCase(),location,disruption,sort,direction}));
   }
   if(req.method==='GET'&&p==='/api/v1/inventory'){
    if(!requireRole(req,res,s,'HUB_INCHARGE'))return;
    const page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||25),q=url.searchParams.get('q')||'',status=url.searchParams.get('status')||'';
    if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||limit<1||limit>100)return json(res,400,{success:false,error:'page must be positive and limit must be between 1 and 100.'});
    if(q.length>100||status&&!['In Stock','Low Stock','Out of Stock'].includes(status))return json(res,400,{success:false,error:'Invalid inventory search or stock status.'});
    if(q.length>100)return json(res,400,{success:false,error:'q must be 100 characters or fewer.'});return json(res,200,inventoryRegister({page,limit,q,status}));
   }
   let warehouseMatch=p.match(/^\/api\/v1\/warehouses\/(\d+)(?:\/(inventory|shipments|disruptions|orders|recovery|activities))?$/);
   if(req.method==='GET'&&warehouseMatch){
    if(!requireRole(req,res,s,'HUB_INCHARGE'))return;const id=Number(warehouseMatch[1]),type=warehouseMatch[2];
    if(!Number.isSafeInteger(id)||id<1)return json(res,400,{success:false,error:'Warehouse ID must be a positive integer.'});
    if(!type){const result=warehouseDetail(id);return json(res,result?200:404,result||{success:false,error:'Warehouse not found.'});}
    const page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||25),q=url.searchParams.get('q')||'',status=url.searchParams.get('status')||'',product=url.searchParams.get('product')||'';
    if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||limit<1||limit>100)return json(res,400,{success:false,error:'page must be positive and limit must be between 1 and 100.'});
    if(q.length>100||product.length>100||status.length>40)return json(res,400,{success:false,error:'Search and filter values exceed allowed lengths.'});
    if(type==='inventory'&&status&&!['In Stock','Low Stock','Out of Stock'].includes(status))return json(res,400,{success:false,error:'Invalid stock status.'});
    const result=warehouseCollection(id,type,{page,limit,q,status,product});return json(res,result?200:404,result||{success:false,error:'Warehouse not found.'});
   }
   let inventoryMatch=p.match(/^\/api\/v1\/inventory\/(\d+)$/);
   if(req.method==='GET'&&inventoryMatch){if(!requireRole(req,res,s,'HUB_INCHARGE'))return;const id=Number(inventoryMatch[1]);const result=Number.isSafeInteger(id)&&id>0?inventoryDetail(id):null;return json(res,result?200:(Number.isSafeInteger(id)&&id>0?404:400),result||{success:false,error:'Inventory record not found.'});}
   let productInventoryMatch=p.match(/^\/api\/v1\/products\/([^/]+)\/inventory$/);
   if(req.method==='GET'&&productInventoryMatch){if(!requireRole(req,res,s,'HUB_INCHARGE'))return;const raw=decodeURIComponent(productInventoryMatch[1]);if(!raw||raw.length>100)return json(res,400,{success:false,error:'Invalid product identifier.'});const result=productInventory(raw);return json(res,result?200:404,result||{success:false,error:'Product not found.'});}
   // Page 10: internal Customer Order Management. Customer-facing endpoints remain isolated above.
   if(req.method==='GET'&&p==='/api/v1/orders/overview'){if(!requireRole(req,res,s,'HUB_INCHARGE'))return;return json(res,200,orderOverview());}
   if(req.method==='GET'&&p==='/api/v1/orders'){
    if(!requireRole(req,res,s,'HUB_INCHARGE'))return;
    const page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||25),q=url.searchParams.get('q')||'',status=url.searchParams.get('status')||'',risk=url.searchParams.get('risk')||'',disruption=url.searchParams.get('disruption')||'',warehouse=url.searchParams.get('warehouse')||'',from=url.searchParams.get('from')||'',to=url.searchParams.get('to')||'',sort=url.searchParams.get('sort')||'date',direction=url.searchParams.get('direction')||'desc';
    if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||limit<1||limit>100)return json(res,400,{success:false,error:'page must be positive and limit must be between 1 and 100.'});
    if(q.length>100||status.length>40||warehouse.length>20)return json(res,400,{success:false,error:'Search and filter values exceed allowed lengths.'});
    if(status&&!all('SELECT DISTINCT status FROM customer_orders').some(x=>x.status.toLowerCase()===status.toLowerCase()))return json(res,400,{success:false,error:'Unknown order status.'});
    if(risk&&!['low','medium','high','critical','unavailable'].includes(risk.toLowerCase()))return json(res,400,{success:false,error:'risk must be low, medium, high, critical or unavailable.'});
    if(disruption&&!['yes','no'].includes(disruption))return json(res,400,{success:false,error:'disruption must be yes or no.'});
    if(warehouse&&(!/^\d+$/.test(warehouse)||!get('SELECT id FROM warehouses WHERE id=?',Number(warehouse))))return json(res,400,{success:false,error:'warehouse must reference an existing warehouse ID.'});
    const validDate=v=>{if(!v)return true;if(!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const d=new Date(`${v}T00:00:00.000Z`);return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;};
    if(!validDate(from)||!validDate(to)||(from&&to&&from>to))return json(res,400,{success:false,error:'from and to must be valid YYYY-MM-DD dates and from cannot exceed to.'});
    if(!['date','order','customer','status','deadline','items'].includes(sort)||!['asc','desc'].includes(direction))return json(res,400,{success:false,error:'Invalid order sorting options.'});
    return json(res,200,orderList({page,limit,q,status,risk,disruption,warehouse,from,to,sort,direction}));
   }
   const orderMatch=p.match(/^\/api\/v1\/orders\/(\d+)(?:\/(items|shipments|disruptions|risk|recovery|activities))?$/);
   if(req.method==='GET'&&orderMatch){
    if(!requireRole(req,res,s,'HUB_INCHARGE'))return;
    const id=Number(orderMatch[1]),type=orderMatch[2];if(!Number.isSafeInteger(id)||id<1)return json(res,400,{success:false,error:'Order ID must be a positive integer.'});
    if(!type){const result=orderDetail(id);return json(res,result?200:404,result||{success:false,error:'Order not found.'});}
    if(type==='items'){const page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||25);if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(limit)||limit<1||limit>100)return json(res,400,{success:false,error:'Invalid pagination.'});const result=orderItems(id,{page,limit});return json(res,result?200:404,result||{success:false,error:'Order not found.'});}
    const handlers={shipments:orderShipments,disruptions:orderDisruptions,risk:orderRisk,recovery:orderRecovery,activities:orderActivities};const result=handlers[type](id);return json(res,result?200:404,result||{success:false,error:'Order not found.'});
   }

   if(req.method==='GET'&&p==='/api/v1/disruptions')return json(res,200,listDisruptions(url));
   m=p.match(/^\/api\/v1\/disruptions\/(\d+)$/);if(req.method==='GET'&&m){const d=get(`SELECT d.*,s.tracking_number,s.carrier,w.code AS warehouse_code,w.name AS warehouse_name,(SELECT COUNT(DISTINCT x.customer_order_id) FROM disruption_affected_orders x WHERE x.disruption_id=d.id) AS affected_orders FROM disruptions d LEFT JOIN shipments s ON s.id=d.shipment_id LEFT JOIN warehouses w ON w.id=COALESCE(d.warehouse_id,s.destination_warehouse_id) WHERE d.id=?`,Number(m[1]));return json(res,d?200:404,d?{success:true,disruption:d}:{success:false,error:'Disruption not found.'});}
   if(req.method==='POST'&&p==='/api/v1/disruptions/scan'){if(!requireMutation(req,res,s))return;if(!requireExactRole(req,res,s,'HUB_INCHARGE','RISK_ANALYST','RECOVERY_MANAGER'))return;return json(res,200,{success:true,result:runFullDisruptionScan(user)});}
   m=p.match(/^\/api\/v1\/disruptions\/(\d+)\/impact$/);if(req.method==='GET'&&m){const result=analyzeDisruptionImpact(Number(m[1]));return json(res,result.error?404:200,{success:!result.error,...result});}
   m=p.match(/^\/api\/v1\/disruptions\/(\d+)\/summary$/);if(req.method==='GET'&&m){const result=await getDisruptionSummary(Number(m[1]),url.searchParams.get('refresh')==='true');return json(res,result.error?404:200,result);}
   m=p.match(/^\/api\/v1\/shipments\/(\d+)\/evaluate$/);if(req.method==='POST'&&m){if(!requireMutation(req,res,s))return;if(!requireExactRole(req,res,s,'HUB_INCHARGE','RISK_ANALYST','RECOVERY_MANAGER'))return;const b=await readBody(req);return json(res,200,{success:true,disruption:evaluateAndRecordShipmentDisruption(Number(m[1]),Number(b.delay_hours||0),String(b.reason||''))});}

   // Risk intelligence: all figures are derived from the deterministic domain engine.
   if(req.method==='GET'&&p==='/api/v1/risks/overview'){
    const assessed=scoreAndRankAllAffectedOrders();const total=Number(get('SELECT COUNT(*) AS n FROM customer_orders').n||0);
    const byOrder=new Map();for(const row of assessed){const prior=byOrder.get(row.order_id);if(!prior||row.final_risk_score>prior.final_risk_score)byOrder.set(row.order_id,row);}
    const unique=[...byOrder.values()],counts={critical:0,high:0,medium:0,low:0};for(const row of unique){const k=String(row.severity||'').toLowerCase();if(Object.hasOwn(counts,k))counts[k]++;}
    const activeHigh=Number(get("SELECT COUNT(*) AS n FROM disruptions WHERE status IN ('Active','Investigating') AND lower(severity) IN ('critical','high')").n||0);
    return json(res,200,{success:true,overview:{total_assessed:unique.length,not_assessed:Math.max(0,total-unique.length),total_orders:total,...counts,high_risk_shipments:null,active_high_severity_disruptions:activeHigh},generated_at:nowIso()});
   }
   if(req.method==='GET'&&p==='/api/v1/risks/heatmap'){
    const rows=scoreAndRankAllAffectedOrders();const severities=['Critical','High','Medium','Low'];const factors=['deadline_risk','shortage_risk','customer_priority','recovery_difficulty'];
    const cells=severities.map(severity=>({severity,categories:factors.map(factor=>({factor,count:rows.filter(r=>r.severity===severity&&Number(r.components?.[factor]?.score||0)>=50).length}))}));
    return json(res,200,{success:true,cells,dimensions:{severity:severities,impact_category:factors},note:'Cells count assessed orders with the named contributing factor score at or above 50. An order can appear in more than one category.'});
   }
   if(req.method==='GET'&&p==='/api/v1/risks'){
    const filters={disruptionId:url.searchParams.get('disruption_id')||undefined,severity:url.searchParams.get('severity')||undefined,status:url.searchParams.get('status')||undefined,priority:url.searchParams.get('priority')||undefined,q:url.searchParams.get('q')||undefined};
    if((filters.q||'').length>100)return json(res,400,{success:false,error:'Search query must be 100 characters or fewer.'});
    if(filters.severity&&!['Critical','High','Medium','Low'].includes(filters.severity))return json(res,400,{success:false,error:'Unknown risk severity.'});
    const rows=scoreAndRankAllAffectedOrders(filters);return json(res,200,{success:true,count:rows.length,risks:rows});
   }
   let riskDetailMatch=p.match(/^\/api\/v1\/risks\/(\d+)$/);
   if(req.method==='GET'&&riskDetailMatch){const orderId=Number(riskDetailMatch[1]),disId=Number(url.searchParams.get('disruption_id')||0);const pairs=disId?[{id:disId}]:all('SELECT d.id FROM disruptions d JOIN disruption_affected_orders x ON x.disruption_id=d.id WHERE x.customer_order_id=? AND d.status IN (\'Active\',\'Investigating\') ORDER BY d.detected_at DESC',orderId);const risk=pairs.map(x=>calculateOrderRisk(orderId,x.id)).find(Boolean);return json(res,risk?200:404,risk?{success:true,risk}:{success:false,error:'No verified active risk assessment exists for this order.'});}
   // What-if simulations are persisted separately and never mutate operational tables.
   if(req.method==='GET'&&p==='/api/v1/simulations'){if(!requireExactRole(req,res,s,'RISK_ANALYST','HUB_INCHARGE','RECOVERY_MANAGER'))return;return json(res,200,{success:true,count:listSimulations().length,simulations:listSimulations()});}
   if(req.method==='POST'&&p==='/api/v1/simulations'){
    if(!requireMutation(req,res,s))return;if(!requireExactRole(req,res,s,'RISK_ANALYST','HUB_INCHARGE','RECOVERY_MANAGER'))return;const b=await readBody(req,32*1024);const outcome=evaluateSimulation(b,user.id);
    if(outcome.error)return json(res,400,{success:false,error:outcome.error});
    audit({userId:user.id,action:'SIMULATION_CREATED',entityType:'Simulation',entityId:outcome.simulation.id,details:`${outcome.simulation.simulation_code} · ${outcome.simulation.scenario_type}; simulated only.`});
    return json(res,201,{success:true,simulation:outcome.simulation});
   }
   let simulationMatch=p.match(/^\/api\/v1\/simulations\/(\d+)$/);
   if(req.method==='GET'&&simulationMatch){if(!requireExactRole(req,res,s,'RISK_ANALYST','HUB_INCHARGE','RECOVERY_MANAGER'))return;const simulation=getSimulation(Number(simulationMatch[1]));return json(res,simulation?200:404,simulation?{success:true,simulation}:{success:false,error:'Simulation not found.'});}
   if(req.method==='POST'&&p==='/api/v1/simulations/compare'){
    if(!requireMutation(req,res,s))return;if(!requireExactRole(req,res,s,'RISK_ANALYST','HUB_INCHARGE','RECOVERY_MANAGER'))return;const b=await readBody(req,16*1024);const ids=Array.isArray(b.ids)?[...new Set(b.ids.map(Number))].filter(x=>Number.isSafeInteger(x)&&x>0).slice(0,4):[];
    if(ids.length<2)return json(res,400,{success:false,error:'Select at least two saved simulations to compare.'});const simulations=ids.map(getSimulation).filter(Boolean);if(simulations.length!==ids.length)return json(res,404,{success:false,error:'One or more simulations were not found.'});
    return json(res,200,{success:true,simulations,comparison:{labels:simulations.map(x=>x.title),affected_orders:simulations.map(x=>x.result.affected_orders.length),affected_shipments:simulations.map(x=>x.result.affected_shipments.length),risk_assessed:simulations.map(x=>x.result.risk.assessed_orders)}});
   }
   // Risk engine API: read-only and deterministic, same 35/30/20/15 weighted formula as Python.
   if(req.method==='GET'&&['/api/v1/risk/queue','/api/risk-queue'].includes(p)){const orders=scoreAndRankAllAffectedOrders({disruptionId:url.searchParams.get('disruption_id')?Number(url.searchParams.get('disruption_id')):undefined,severity:url.searchParams.get('severity'),status:url.searchParams.get('status'),priority:url.searchParams.get('priority'),q:url.searchParams.get('q')});return json(res,200,{success:true,count:orders.length,orders});}
   m=p.match(/^\/api\/v1\/orders\/(\d+)\/risk-explanation$/);if(req.method==='GET'&&m){const disId=url.searchParams.get('disruption_id');const result=await explainOrderRisk(Number(m[1]),disId?Number(disId):null,['true','1'].includes(url.searchParams.get('refresh')));return json(res,result.error?404:200,result);}

   // Recovery planning, workflow and simulated execution.
   m=p.match(/^\/api\/v1\/disruptions\/(\d+)\/recovery-options$/);if(req.method==='GET'&&m){if(!requireExactRole(req,res,s,'HUB_INCHARGE','RECOVERY_MANAGER'))return;return json(res,200,{success:true,options:generateRecoveryRecommendations(Number(m[1]))});}
   m=p.match(/^\/api\/recovery-plans\/(?:compare|compare-options)\/(\d+)$/);if(req.method==='GET'&&m){const result=getScenarioComparison(Number(m[1]),null,false);return json(res,result.error?404:200,{success:!result.error,data:result});}
   if(req.method==='POST'&&p==='/api/v1/recovery-plans/from-recommendation'){if(!requireMutation(req,res,s))return;if(!requireExactRole(req,res,s,'HUB_INCHARGE'))return;const b=await readBody(req);const options=generateRecoveryRecommendations(Number(b.disruption_id));const opt=options.find(x=>x.option_id===b.option_id);if(!opt)return json(res,404,{error:'Recommendation option not found.'});return json(res,201,{success:true,plan:createPlanFromRecommendation(Number(b.disruption_id),opt,user)});}
   if(req.method==='POST'&&p==='/api/v1/recovery-plans'){if(!requireMutation(req,res,s))return;if(!requireExactRole(req,res,s,'HUB_INCHARGE'))return;const b=await readBody(req,32*1024);const disruptionId=Number(b.disruption_id),title=String(b.title||'').trim(),quantity=Number(b.quantity),rationale=String(b.rationale||'').trim();if(!Number.isSafeInteger(disruptionId)||disruptionId<1)return json(res,400,{success:false,error:'Select a valid active disruption.'});if(title.length<5||title.length>160)return json(res,400,{success:false,error:'Plan title must be 5–160 characters.'});if(!Number.isInteger(quantity)||quantity<1||quantity>100000)return json(res,400,{success:false,error:'Orders to reprioritise must be a whole number from 1 to 100,000.'});if(rationale.length<12||rationale.length>1200)return json(res,400,{success:false,error:'Add an operational rationale of 12–1,200 characters.'});const d=get("SELECT * FROM disruptions WHERE id=? AND status IN ('Active','Investigating')",disruptionId);if(!d)return json(res,404,{success:false,error:'The selected disruption is not currently active.'});const code='REC-'+d.disruption_code.slice(-7)+'-'+Date.now().toString(36).toUpperCase();const now=nowIso();const linkedCount=Number(get('SELECT COUNT(DISTINCT customer_order_id) AS n FROM disruption_affected_orders WHERE disruption_id=?',disruptionId).n||0);if(!linkedCount)return json(res,409,{success:false,error:'This disruption has no explicitly linked customer orders. Use an evidence-backed recommendation instead of creating an order-reprioritisation plan.'});if(quantity>linkedCount)return json(res,400,{success:false,error:`Quantity cannot exceed the ${linkedCount} customer orders explicitly linked to this disruption.`});const linked=get('SELECT customer_order_id FROM disruption_affected_orders WHERE disruption_id=? ORDER BY customer_order_id LIMIT 1',disruptionId);db.exec('BEGIN IMMEDIATE');try{const created=run("INSERT INTO recovery_plans(plan_code,disruption_id,customer_order_id,title,strategy_type,status,quantity,estimated_cost,cost_estimate_verified,description,rationale,version,created_by_id,created_at,updated_at,protected_value,priority,progress,data_origin) VALUES(?,?,?,?,'Order Reprioritisation','Draft',?,0,0,?,?,1,?,?,?,0,?,0,'operational')",code,disruptionId,linked?.customer_order_id||null,title,quantity,title,rationale,user.id,now,now,String(d.severity||'Medium').toLowerCase()==='critical'?'Critical':'High');const id=Number(created.lastInsertRowid);run("INSERT INTO recovery_actions(recovery_plan_id,action_sequence,action_type,description,status,cost,assigned_to_role,data_origin) VALUES(?,1,'ORDER_REPRIORITISATION',?,'Pending',0,'HUB_INCHARGE','operational')",id,`Review and reprioritise up to ${quantity} explicitly linked orders after approval.`);audit({userId:user.id,action:'CREATE_RECOVERY_PLAN',entityType:'RecoveryPlan',entityId:id,details:`Created ${code} for ${d.disruption_code}; draft only, no orders changed.`});db.exec('COMMIT');return json(res,201,{success:true,plan:get('SELECT * FROM recovery_plans WHERE id=?',id)});}catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}}
   if(req.method==='GET'&&p==='/api/v1/recovery-plans'){if(!requireExactRole(req,res,s,'HUB_INCHARGE','RECOVERY_MANAGER'))return;const plans=all("SELECT p.*,d.disruption_code FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id WHERE p.data_origin IN ('operational','synthetic_demo') ORDER BY CASE p.status WHEN 'Pending Approval' THEN 0 WHEN 'Approved' THEN 1 WHEN 'Draft' THEN 2 ELSE 3 END,p.created_at DESC");return json(res,200,{success:true,count:plans.length,plans:plans.map(p=>({...p,is_demo_draft:p.data_origin==='synthetic_demo',is_approval_valid:p.status==='Approved'&&p.approval_version===p.version,actions:all("SELECT * FROM recovery_actions WHERE recovery_plan_id=? AND data_origin IN ('operational','synthetic_demo') ORDER BY action_sequence",p.id)}))});}
   m=p.match(/^\/api\/v1\/recovery-plans\/(\d+)$/);
   if(req.method==='GET'&&m){if(!requireExactRole(req,res,s,'HUB_INCHARGE','RECOVERY_MANAGER'))return;const plan=get("SELECT p.*,d.disruption_code FROM recovery_plans p JOIN disruptions d ON d.id=p.disruption_id WHERE p.id=? AND p.data_origin='operational'",Number(m[1]));if(!plan)return json(res,404,{success:false,error:'Recovery plan not found.'});const impact=analyzeDisruptionImpact(plan.disruption_id);const source_inventory=plan.source_warehouse_id&&plan.sku?get('SELECT i.sku,i.quantity,i.reserved_quantity,i.reorder_point,MAX(0,i.quantity-i.reserved_quantity) AS available,w.code AS warehouse_code FROM inventories i JOIN warehouses w ON w.id=i.warehouse_id WHERE i.warehouse_id=? AND i.sku=?',plan.source_warehouse_id,plan.sku):null;const destination_inventory=plan.destination_warehouse_id&&plan.sku?get('SELECT i.sku,i.quantity,i.reserved_quantity,i.reorder_point,MAX(0,i.quantity-i.reserved_quantity) AS available,w.code AS warehouse_code FROM inventories i JOIN warehouses w ON w.id=i.warehouse_id WHERE i.warehouse_id=? AND i.sku=?',plan.destination_warehouse_id,plan.sku):null;const affected_orders=impact.orders_affected||[];const customer_accounts=all(`SELECT DISTINCT u.id FROM customer_orders o JOIN disruption_affected_orders x ON x.customer_order_id=o.id JOIN users u ON u.customer_id=o.customer_id AND u.role='CUSTOMER' AND u.is_active=1 WHERE x.disruption_id=?`,plan.disruption_id).length;return json(res,200,{success:true,plan:{...plan,is_approval_valid:plan.status==='Approved'&&plan.approval_version===plan.version,actions:all("SELECT * FROM recovery_actions WHERE recovery_plan_id=? AND data_origin='operational' ORDER BY action_sequence",plan.id),approvals:all("SELECT a.*,u.full_name AS requester,ap.full_name AS approver FROM approvals a JOIN users u ON u.id=a.requester_id LEFT JOIN users ap ON ap.id=a.approver_id WHERE a.recovery_plan_id=? AND a.data_origin='operational' ORDER BY a.requested_at DESC",plan.id),stock_movements:all('SELECT * FROM stock_movements WHERE recovery_plan_id=? ORDER BY created_at DESC',plan.id),impact:{shipment:impact.shipment||null,affected_orders:affected_orders.map(o=>({order_number:o.order_number,status:o.status,priority:o.priority,delivery_deadline:o.delivery_deadline})),source_inventory,destination_inventory,customer_accounts_to_notify:customer_accounts,execution_disclosure:'Simulated database execution only. No real carrier booking, physical stock movement, or delivery confirmation.'}}});}
   if(req.method==='PATCH'&&m){if(!requireMutation(req,res,s))return;if(!requireExactRole(req,res,s,'HUB_INCHARGE'))return;const b=await readBody(req);const result=modifyRecoveryPlan(Number(m[1]),user,b);return json(res,result.ok?200:400,result);}
   m=p.match(/^\/api\/v1\/recovery-plans\/(\d+)\/submit-approval$/);if(req.method==='POST'&&m){if(!requireMutation(req,res,s))return;if(!requireExactRole(req,res,s,'HUB_INCHARGE'))return;const result=submitPlanForApproval(Number(m[1]),user);return json(res,result.ok?200:400,result);}
   m=p.match(/^\/api\/v1\/recovery-plans\/(\d+)\/decision$/);if(req.method==='POST'&&m){if(!requireMutation(req,res,s))return;if(!requireExactRole(req,res,s,'RECOVERY_MANAGER'))return;const b=await readBody(req);const result=reviewPlanApproval(Number(m[1]),user,String(b.decision||''),String(b.comments||''));return json(res,result.ok?200:400,result);}
   m=p.match(/^\/api\/v1\/recovery-plans\/(\d+)\/execute$/);if(req.method==='POST'&&m){if(!requireMutation(req,res,s))return;if(!requireExactRole(req,res,s,'RECOVERY_MANAGER'))return;const b=await readBody(req);const result=executeSimulatedRecoveryPlan(Number(m[1]),user,{idempotencyKey:String(b.idempotency_key||''),confirmation:b.confirmation===true});return json(res,result.ok?200:409,result);}
   if(req.method==='GET'&&p==='/api/v1/approvals'){if(!requireExactRole(req,res,s,'HUB_INCHARGE','RECOVERY_MANAGER'))return;const rows=all(`SELECT a.*,p.plan_code,p.title AS plan_title,p.status AS plan_status,p.estimated_cost,p.cost_estimate_verified,p.protected_value,req.full_name AS requester,decider.full_name AS approver FROM approvals a JOIN recovery_plans p ON p.id=a.recovery_plan_id JOIN users req ON req.id=a.requester_id LEFT JOIN users decider ON decider.id=a.approver_id WHERE a.data_origin='operational' AND p.data_origin='operational' AND req.role='HUB_INCHARGE' AND a.required_role='RECOVERY_MANAGER' ORDER BY CASE a.status WHEN 'Pending' THEN 0 ELSE 1 END,a.requested_at DESC`);return json(res,200,{success:true,count:rows.length,approvals:rows});}
   if(req.method==='GET'&&p==='/api/v1/audit-logs'){if(!requireExactRole(req,res,s,'HUB_INCHARGE','RECOVERY_MANAGER'))return;const {limit,offset}=parsePagination(url);const rows=all(`SELECT a.*,u.username,u.full_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.data_origin='operational' ORDER BY a.timestamp DESC LIMIT ? OFFSET ?`,limit,offset);return json(res,200,{success:true,logs:rows});}
   if(req.method==='GET'&&p==='/api/v1/admin/system-status'){
    if(!requireExactRole(req,res,s,'HUB_INCHARGE','RECOVERY_MANAGER'))return;
    const counts=['customers','users','suppliers','warehouses','inventories','shipments','customer_orders','disruptions','recovery_plans','approvals','webhook_events','notifications','simulation_runs','stock_movements'].map(t=>({label:t.replaceAll('_',' ').toUpperCase(),value:Number(get(`SELECT COUNT(*) AS n FROM ${t}`).n||0)}));
    const accounts=all('SELECT username,full_name,role,is_active,last_login FROM users ORDER BY role,username');
    const health={runtime:process.version,ai_provider:(String(process.env.LLM_PROVIDER||'none').toLowerCase()!=='none'&&process.env.LLM_API_KEY)?'Configured (server-side)':'Not configured · deterministic mode',carrier_api:'Not configured · simulator only',gps_tracking:'Not configured',route_optimisation:'Not configured'};
    return json(res,200,{success:true,health,metrics:counts,accounts,environment:process.env.NODE_ENV||'development'});
   }
   if(req.method==='GET'&&p==='/api/v1/webhooks/history'){
    if(!requireRole(req,res,s,'HUB_INCHARGE'))return;
    const {limit,offset}=parsePagination(url);const events=all("SELECT id,event_identifier,source,event_type,processing_status,received_at,processed_at,payload_json,error_details FROM webhook_events WHERE data_origin='operational' ORDER BY received_at DESC LIMIT ? OFFSET ?",limit,offset).map(x=>{let payload={};try{payload=JSON.parse(x.payload_json||'{}')}catch{}return{...x,event_timestamp:payload.event_timestamp||null,detail:x.error_details||payload.reason||payload.tracking_number||'Simulated carrier event',payload_json:undefined};});
    return json(res,200,{success:true,events});
   }
   if(req.method==='GET'&&p==='/api/v1/imports/history'){
    if(!requireRole(req,res,s,'HUB_INCHARGE'))return;
    const logs=all(`SELECT a.*,u.username,u.full_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.data_origin='operational' AND a.action LIKE 'IMPORT_%' ORDER BY a.timestamp DESC LIMIT 100`);
    return json(res,200,{success:true,logs});
   }

   // CSV / JSON import with Python-compatible 2 MB cap, validation and dry-run preview.
   if(req.method==='POST'&&p==='/api/v1/imports'){
    if(!requireMutation(req,res,s))return;if(!requireRole(req,res,s,'HUB_INCHARGE'))return;
    const b=await readBody(req,2*1024*1024+64*1024);const entity=String(b.entity||url.searchParams.get('entity')||'');const filename=String(b.filename||'api-upload');let records=b.records;
    if(!records&&Array.isArray(b.shipments)){records=b.shipments;}
    if(!records&&Array.isArray(b.inventory)){records=b.inventory;}
    if(!records&&typeof b.csv==='string')records=parseCSV(b.csv);
    if(!records&&typeof b.raw==='string')records=parseCSV(b.raw);
    if(!records&&typeof b.json==='string'){try{const parsed=JSON.parse(b.json);records=Array.isArray(parsed)?parsed:parsed[entity]||parsed.shipments||parsed.inventory;}catch{return json(res,400,{success:false,error:'Invalid JSON import content.'});}}
    const result=importRecords(entity,records,user,{dryRun:b.dry_run===true||b.dryRun===true,filename,allowUpdates:b.allow_updates===true});return json(res,result.success?200:400,{success:result.success,result});
   }

   // Advisory AI endpoints ported from the Python /api/insights contract.
   m=p.match(/^\/api\/insights\/disruptions\/(\d+)\/summary$/);
   if(req.method==='GET'&&m){const result=await getDisruptionSummary(Number(m[1]),['true','1'].includes(url.searchParams.get('refresh')));return json(res,result.error?404:200,{success:!result.error,disruption_id:Number(m[1]),data:result});}
   m=p.match(/^\/api\/insights\/orders\/(\d+)\/risk-explanation$/);
   if(req.method==='GET'&&m){const disruptionId=url.searchParams.get('disruption_id');const result=await explainOrderRisk(Number(m[1]),disruptionId?Number(disruptionId):null,['true','1'].includes(url.searchParams.get('refresh')));return json(res,result.error?404:200,{success:!result.error,order_id:Number(m[1]),data:result});}
   if(req.method==='POST'&&p==='/api/insights/orders/compare-ranking'){
    if(!requireMutation(req,res,s))return;const b=await readBody(req,32*1024);const a=Number(b.order_a_id),c=Number(b.order_b_id);if(!Number.isInteger(a)||!Number.isInteger(c))return json(res,400,{success:false,error:'Both order_a_id and order_b_id must be valid integers.'});const result=explainOrderRanking(a,c,b.disruption_id);return json(res,result.error?404:200,{success:!result.error,data:result});
   }
   m=p.match(/^\/api\/insights\/disruptions\/(\d+)\/recovery-explanation\/([^/]+)$/);
   if(req.method==='GET'&&m){const result=explainRecoveryCandidate(Number(m[1]),decodeURIComponent(m[2]),['true','1'].includes(url.searchParams.get('refresh')));return json(res,result.error?404:200,{success:!result.error,data:result});}
   m=p.match(/^\/api\/insights\/disruptions\/(\d+)\/scenario-comparison$/);
   if(req.method==='GET'&&m){const result=getScenarioComparison(Number(m[1]),url.searchParams.get('option_id')||null,['true','1'].includes(url.searchParams.get('refresh')));return json(res,result.error?404:200,{success:!result.error,data:result});}
   if(req.method==='POST'&&['/api/insights/cache/clear','/api/v1/ai/cache/clear'].includes(p)){if(!requireMutation(req,res,s))return;if(!requireRole(req,res,s,'HUB_INCHARGE'))return;clearCache();return json(res,200,{success:true,message:'AI insight cache cleared successfully.'});}

   if(req.method==='POST'&&p==='/api/webhooks/simulator'){if(!requireMutation(req,res,s))return;const b=await readBody(req,256*1024);const result=processCarrierEvent({...b,event_id:b.event_id||b.event_identifier});return json(res,result.status,result.body);}

   // Notifications.
   if(req.method==='GET'&&p==='/api/v1/notifications'){const rows=all('SELECT * FROM notifications WHERE recipient_user_id=? OR (recipient_user_id IS NULL AND (recipient_role=? OR recipient_role IS NULL)) ORDER BY created_at DESC,id DESC LIMIT 50',user.id,user.role);return json(res,200,{success:true,count:rows.length,unread_count:rows.filter(x=>!x.is_read).length,notifications:rows});}
   if(req.method==='POST'&&/^\/api\/v1\/notifications\/\d+\/read$/.test(p)){if(!requireMutation(req,res,s))return;const id=Number(p.split('/')[4]);const changed=run('UPDATE notifications SET is_read=1 WHERE id=? AND (recipient_user_id=? OR (recipient_user_id IS NULL AND (recipient_role=? OR recipient_role IS NULL)))',id,user.id,user.role);return json(res,200,{success:true,updated:Number(changed.changes||0)===1});}

   return json(res,404,{success:false,error:'API route not found.'});
  }

  // Carrier webhook ingestion: optionally signed in development; mandatory signature in production.
  if(req.method==='POST'&&p==='/api/webhooks/carrier'){
   const secret=process.env.WEBHOOK_SECRET||'';
   if(process.env.NODE_ENV==='production'&&!secret)return json(res,503,{success:false,error:'WEBHOOK_SECRET must be configured in production.'});
   if(secret&&req.headers['x-webhook-secret']!==secret)return json(res,401,{success:false,error:'Invalid webhook signature.'});
   const b=await readBody(req,1024*1024);const result=processCarrierEvent({...b,event_id:b.event_id||b.event_identifier});return json(res,result.status,result.body);
  }

  // Static frontend assets.
  const file=safeStatic(p);if(req.method==='GET'&&file)return serveFile(file,res);
  return send(res,404,'Not found',{'Content-Type':'text/plain; charset=utf-8'});
 }catch(error){console.error(`[${new Date().toISOString()}] ${req.method} ${p}:`,error);if(!res.headersSent)return json(res,500,{success:false,error:'Internal server error. Please retry the request.'});res.destroy();}
});

let activePort=BASE_PORT;
let portAttempts=0;
function printStartup(){
 const address=server.address();
 activePort=typeof address==='object'&&address?address.port:activePort;
 console.log('\nDisruptionIQ 7.0 — migrated Node.js backend');
 console.log(`Login:     http://127.0.0.1:${activePort}/login`);
 console.log(`Overview:  http://127.0.0.1:${activePort}/app/overview`);
 console.log(`Health:    http://127.0.0.1:${activePort}/health`);
 console.log(`Database:  ${require('./src/database').DB_PATH}`);
 if(BASE_PORT!==REQUESTED_PORT)console.log(`NOTE: Requested port ${REQUESTED_PORT} is restricted by Chromium/Edge. Using browser-safe port ${BASE_PORT}.`);
 if(activePort!==BASE_PORT)console.log(`NOTE: Port ${BASE_PORT} was already in use. DisruptionIQ automatically selected browser-safe port ${activePort}.`);
 if(process.env.NODE_ENV!=='production')console.log('Development demo roles: Hub In-Charge, Risk Analyst, Recovery Manager and Customer (credentials are documented in README).');
 console.log('Risk scoring: deterministic Python formula port (35/30/20/15).');
 console.log('Note: simulated recovery does not place real orders or carrier bookings.\n');
}
function listenOnAvailablePort(port){
 activePort=port;
 portAttempts+=1;
 server.listen(port,HOST);
}
server.on('listening',printStartup);
server.on('error',(error)=>{
 if(error.code==='EADDRINUSE'&&PORT_FALLBACK_ENABLED&&portAttempts<MAX_PORT_ATTEMPTS){
  const nextPort=nextBrowserSafePort(activePort);
  console.warn(`[DisruptionIQ] Port ${activePort} is already in use. Trying browser-safe port ${nextPort}...`);
  try{listenOnAvailablePort(nextPort);}catch(nextError){console.error('[DisruptionIQ] Unable to start server:',nextError.message);process.exitCode=1;}
  return;
 }
 console.error(`[DisruptionIQ] Could not listen on ${HOST}:${activePort}: ${error.message}`);
 if(error.code==='EADDRINUSE')console.error('Close the process using this port, choose another PORT, or increase PORT_SCAN_LIMIT.');
 process.exitCode=1;
 try{db.close();}catch{}
});
listenOnAvailablePort(BASE_PORT);
function shutdown(){try{server.close(()=>{db.close();process.exit(0);});}catch{try{db.close();}catch{}process.exit(0);}}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
