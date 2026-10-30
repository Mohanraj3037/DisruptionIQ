'use strict';
const fs=require('node:fs');
const path=require('node:path');
const source=process.argv[2];
const destination=process.argv[3]||path.resolve(__dirname,'../instance/disruptioniq-imported.db');
if(!source){console.error('Usage: node scripts/import-sqlite.js <python-instance-db> [destination-db]');process.exit(2);}
const src=path.resolve(source),dest=path.resolve(destination);
if(!fs.existsSync(src)){console.error(`Source SQLite database not found: ${src}`);process.exit(2);}
if(src===dest){console.error('Source and destination must be different files.');process.exit(2);}
process.env.DATABASE_PATH=dest;
process.env.DIQ_SKIP_SEED='1';
const {db}=require('../src/database');
const tables=['users','suppliers','warehouses','inventories','shipments','shipment_items','customer_orders','order_items','disruptions','disruption_affected_orders','recovery_plans','recovery_actions','approvals','audit_logs','webhook_events','notifications'];
const quote=s=>'"'+String(s).replace(/"/g,'""')+'"';
try{
  db.prepare('ATTACH DATABASE ? AS legacy').run(src);
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
  const sourceTables=new Set(db.prepare("SELECT name FROM legacy.sqlite_master WHERE type='table'").all().map(x=>x.name));
  const report=[];
  for(const table of tables){
    if(!sourceTables.has(table)){report.push({table,status:'not present in source',rows:0});continue;}
    const sourceCols=db.prepare(`PRAGMA legacy.table_info(${quote(table)})`).all().map(x=>x.name);
    const targetCols=db.prepare(`PRAGMA main.table_info(${quote(table)})`).all().map(x=>x.name);
    const cols=targetCols.filter(c=>sourceCols.includes(c));
    if(!cols.length){report.push({table,status:'no compatible columns',rows:0});continue;}
    const before=Number(db.prepare(`SELECT COUNT(*) AS n FROM main.${quote(table)}`).get().n);
    db.exec(`INSERT OR REPLACE INTO main.${quote(table)} (${cols.map(quote).join(',')}) SELECT ${cols.map(quote).join(',')} FROM legacy.${quote(table)}`);
    const after=Number(db.prepare(`SELECT COUNT(*) AS n FROM main.${quote(table)}`).get().n);
    report.push({table,status:'imported',rows:Math.max(0,after-before),total:after,columns:cols.length});
  }
  db.exec('COMMIT; PRAGMA foreign_keys=ON;');
  const fk=db.prepare('PRAGMA foreign_key_check').all();
  console.log(JSON.stringify({source:src,destination:dest,tables:report,foreignKeyViolations:fk.length},null,2));
  if(fk.length){console.error('Foreign-key violations detected. Review before using this database.');process.exitCode=1;}
}catch(e){try{db.exec('ROLLBACK; PRAGMA foreign_keys=ON;');}catch{}console.error('Database import failed:',e.message);process.exitCode=1;}
finally{try{db.close();}catch{}}
