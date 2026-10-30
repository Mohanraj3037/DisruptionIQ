'use strict';
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'diq-final-governance-'));
const dbPath=path.join(temp,'final.db');
const env={...process.env,DATABASE_PATH:dbPath,NODE_ENV:'test'};
const bootstrap=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','scripts/bootstrap.js'],{cwd:root,env,encoding:'utf8',timeout:180000});
if(bootstrap.status!==0)throw new Error(`Final bootstrap failed:\n${bootstrap.stdout}\n${bootstrap.stderr}`);
try{
 const db=new DatabaseSync(dbPath);
 const n=sql=>Number(db.prepare(sql).get().n||0);
 let expectedShipments,expectedSuppliers,expectedWarehouses;
 try{
  const active=db.prepare('SELECT email,role,password_hash,customer_id FROM users WHERE is_active=1 ORDER BY email').all();
  assert.equal(active.length,4,'Exactly four demo accounts should be active.');
  assert.deepEqual(active.map(x=>x.role).sort(),['CUSTOMER','HUB_INCHARGE','RECOVERY_MANAGER','RISK_ANALYST']);
  assert.ok(active.every(x=>x.password_hash.startsWith('scrypt$')),'All demo passwords must use scrypt hashes.');
  assert.equal(active.filter(x=>x.role==='CUSTOMER').length,1);
  assert.ok(active.find(x=>x.role==='CUSTOMER').customer_id>0,'Customer must be linked to a customer record.');
  assert.equal(n("SELECT COUNT(*) n FROM users WHERE email LIKE '%@dataset.disruptioniq.local' AND is_active=1"),0,'Workbook identities must never be active login accounts.');
  assert.equal(n("SELECT COUNT(*) n FROM approvals WHERE data_origin!='operational' OR data_origin IS NULL"),0,'Spreadsheet approval fixtures must not remain in the live approval table.');
  assert.equal(n("SELECT COUNT(*) n FROM audit_logs WHERE data_origin!='operational' OR data_origin IS NULL"),0,'Spreadsheet audit fixtures must not remain in the live audit table.');
  assert.equal(n("SELECT COUNT(*) n FROM recovery_plans WHERE data_origin NOT IN ('operational','synthetic_demo') OR data_origin IS NULL"),0,'Only operational records and explicitly labelled synthetic draft templates may remain in the live plan board.');
  assert.ok(n("SELECT COUNT(*) n FROM recovery_plans WHERE data_origin='synthetic_demo' AND status='Draft'")>=1,'The Plans board should have visible synthetic draft templates, never pre-approved or pre-executed.');
  assert.equal(n("SELECT COUNT(*) n FROM approvals a JOIN recovery_plans p ON p.id=a.recovery_plan_id WHERE p.data_origin='synthetic_demo'"),0,'Synthetic draft templates must not have approval decisions.');
  assert.equal(n("SELECT COUNT(*) n FROM recovery_actions a JOIN recovery_plans p ON p.id=a.recovery_plan_id WHERE p.data_origin='synthetic_demo' AND a.status!='Pending'"),0,'Synthetic templates must not have completed execution actions.');
  assert.equal(n("SELECT COUNT(*) n FROM notifications WHERE data_origin='synthetic_demo'"),4,'Four role-specific welcome notifications should be seeded.');
  assert.ok(n("SELECT COUNT(*) n FROM synthetic_reference_records WHERE source_type IN ('approval','legacy_approval')")>=300,'Historical approval fixtures should be preserved as non-actionable reference data.');
  assert.ok(n("SELECT COUNT(*) n FROM synthetic_reference_records WHERE source_type IN ('audit_event','legacy_audit_event')")>=300,'Historical audit fixtures should be preserved as non-actionable reference data.');
  expectedShipments=n('SELECT COUNT(*) n FROM shipments');expectedSuppliers=n('SELECT COUNT(*) n FROM suppliers');expectedWarehouses=n('SELECT COUNT(*) n FROM warehouses');
  assert.ok(expectedShipments>=390,'Imported and India corridor shipments should be present.');
  assert.ok(expectedSuppliers>=350);assert.ok(expectedWarehouses>=350);
  assert.equal(n('SELECT COUNT(*) n FROM shipments WHERE risk_score IS NULL OR risk_score<=0'),0,'Every shipment needs a stored risk score.');
  assert.equal(n('SELECT COUNT(*) n FROM suppliers WHERE reliability_score<0 OR reliability_score>1'),0,'Supplier reliability must use a normalized 0–1 scale.');
  assert.equal(n("SELECT COUNT(*) n FROM warehouses WHERE location LIKE 'Guwahati%'"),1,'A Guwahati network node should exist.');
  assert.equal(n("SELECT COUNT(*) n FROM shipments WHERE tracking_number LIKE 'NET-GHY-%'"),24,'Guwahati inbound/outbound synthetic corridors should be idempotently seeded.');
  assert.ok(n('SELECT COUNT(*) n FROM simulation_runs')>=5,'Scenario examples should be available on a fresh build.');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0,'The imported SQLite dataset must satisfy foreign keys.');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pragma_table_info('approvals') WHERE name='required_role'").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM approvals WHERE required_role!='RECOVERY_MANAGER'").get().n,0,'Approval destination role must be Recovery Manager.');
 }finally{db.close();}
 process.env.DATABASE_PATH=dbPath;process.env.NODE_ENV='test';
 const dbApi=require('../src/database');
 const security=require('../src/security');
 for(const [email,password] of [
  ['hub@disruptioniq.local','Hub@DIQ2026!'],
  ['risk@disruptioniq.local','Risk@DIQ2026!'],
  ['recovery@disruptioniq.local','Recover@DIQ2026!'],
  ['customer@disruptioniq.local','Customer@DIQ2026!']
 ]){const row=dbApi.get('SELECT password_hash FROM users WHERE email=? AND is_active=1',email);assert.ok(row&&security.verifyPassword(password,row.password_hash),`Demo account should authenticate: ${email}`);}
 const shipments=require('../src/services/shipment-service');
 const overview=shipments.shipmentOverview(),geography=shipments.shipmentGeography();
 const dashboard=require('../src/services/data-service').buildDashboardSections();
 assert.equal(overview.summary.total,expectedShipments,'Shipment summary must reconcile to SQLite.');
 assert.equal(geography.total_shipments,expectedShipments);
 assert.equal(geography.mapped_shipments+geography.unmapped_shipments,geography.total_shipments,'Mapped/unmapped route counts must reconcile.');
 assert.ok(geography.mapped_shipments>300&&geography.nodes.length>=13&&geography.routes.length>=10,'City-centre route geography should be data-backed and populated.');
 assert.ok(geography.nodes.some(x=>x.city==='Guwahati'),'Guwahati must be visible in the geographic dataset.');
 assert.ok(geography.nodes.every(x=>Number.isFinite(x.lat)&&Number.isFinite(x.lng)&&x.lat>=6&&x.lat<=38&&x.lng>=68&&x.lng<=98),'Every mapped node must be within India bounding coordinates.');
 assert.equal(dashboard.summary.total_shipments,expectedShipments);
 assert.ok(dashboard.recent_activities.every(x=>!String(x.description).includes('CREATE_DEMO_USER')),'Seeded login fixtures must not appear as real operational audit events.');
 const html=fs.readFileSync(path.join(root,'public/app.html'),'utf8');
 const css=fs.readFileSync(path.join(root,'public/css/reference-frontend.css'),'utf8');
 const appJs=fs.readFileSync(path.join(root,'public/js/app.js'),'utf8');
 assert.match(html,/leaflet@1\.9\.4\/dist\/leaflet\.css/);
 assert.match(html,/BUILD 7\.1\.0/);
 assert.equal((html.match(/data-synthetic-notice/g)||[]).length,1,'Only one synthetic dataset note should appear.');
 assert.doesNotMatch(html,/DATABASE CONNECTED|JURY|JUROR|REVIEWER|SOURCE \/ SYNTHETIC/i,'Obsolete status and jury/reviewer UI must be removed.');
 assert.match(appJs,/tile\.openstreetmap\.org\//);
 assert.match(appJs,/OpenStreetMap contributors/);
 assert.match(appJs,/RISK_ANALYST/);assert.match(appJs,/RECOVERY_MANAGER/);
 assert.equal((html.match(/data-workspace-nav=/g)||[]).length,4,'Each workspace has a single contextual sub-navigation.');
 assert.doesNotMatch(html,/data-workspace-nav[\s\S]{0,600}<section class="scroll-section[\s\S]{0,200}data-workspace-nav=/,'Sub-navigation must not be nested/repeated inside content panels.');
 assert.match(css,/\.synthetic-data-banner/);
 assert.match(css,/position:relative!important;display:flex!important;top:auto!important/);
 assert.match(appJs,/canDecide=state\.currentUser\?\.role==='RECOVERY_MANAGER'/,'Only Recovery Manager can take approval actions.');
 const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
 assert.match(server,/audit_logs_no_update/);assert.match(server,/audit_logs_no_delete/);
 console.log('PASS four roles, scrypt demo login hashes, single customer scope and legacy-account deactivation');
 console.log('PASS spreadsheet governance history archived; only labelled Draft templates are visible, with no fake approvals or completed actions');
 console.log('PASS relational imports, supplier score normalisation, route seeding and foreign-key checks');
 console.log(`PASS shipment overview ${expectedShipments}, mapped ${geography.mapped_shipments}, unmapped ${geography.unmapped_shipments}, ${geography.nodes.length} city nodes, ${geography.routes.length} route groups`);
 console.log('PASS database-backed dashboard totals, single synthetic note, no database badge, no jury/reviewer labels and one subnav per workspace');
}finally{try{fs.rmSync(temp,{recursive:true,force:true});}catch{}}
