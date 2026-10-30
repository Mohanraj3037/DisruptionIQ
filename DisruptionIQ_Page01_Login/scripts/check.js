'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const files=[];
function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,ent.name);if(ent.isDirectory()){if(['instance','uploads'].includes(ent.name))continue;walk(full);}else if(full.endsWith('.js'))files.push(full);}}
walk(root);
let failed=false;
for(const file of files){const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status!==0){failed=true;console.error(`FAIL ${path.relative(root,file)}\n${r.stderr}`);}else console.log(`OK   ${path.relative(root,file)}`);}
try{require('node:sqlite');console.log('OK   node:sqlite available');}catch(e){failed=true;console.error('FAIL node:sqlite unavailable:',e.message);}
console.log(`\nChecked ${files.length} JavaScript files.`);
process.exit(failed?1:0);
