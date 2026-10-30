'use strict';
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const isProduction=process.env.NODE_ENV==='production';
const scripts=isProduction?['normalize-demo-governance.js']:['import-expanded-dataset.js','ensure-india-network.js','normalize-demo-governance.js','seed-demo-simulations.js','seed-recovery-demo-plans.js'];
for(const file of scripts){
 const r=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',path.join(__dirname,file)],{cwd:root,env:process.env,stdio:'inherit'});
 if(r.error)throw r.error;
 if(r.status!==0)throw new Error(`Bootstrap step failed: ${file} (exit ${r.status})`);
}
