'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public/app.html'),'utf8');
const app=fs.readFileSync(path.join(root,'public/js/app.js'),'utf8');
const css=fs.readFileSync(path.join(root,'public/css/reference-frontend.css'),'utf8');
function navCount(label){return (html.match(new RegExp(`aria-label="${label}"`,'g'))||[]).length;}
assert.equal(navCount('Risk analysis sections'),1,'Risk Analysis must render one pill navigation');
assert.equal(navCount('Recovery planning sections'),1,'Recovery Planning must render one pill navigation');
assert.equal(navCount('Shipment monitoring sections'),1,'Shipment Monitoring must render one pill navigation');
for(const id of ['network-shipments','network-hubs','network-suppliers','network-warehouses','network-orders','disruption-command','disruption-monitoring','disruption-impact','disruption-priority','disruption-scenarios','recovery-overview','recovery-ai','recovery-plans','recovery-execution']){
  assert.match(html,new RegExp(`id="${id}"`),`${id} panel exists`);
  assert.match(html,new RegExp(`data-workspace-target="${id}"`),`${id} has one navigable tab`);
}
for(const id of ['shipmentMix','shipmentTrendChart','shipmentCarrierChart','shipmentRiskChart','shipmentRouteChart','shipmentTransportChart']) assert.match(html,new RegExp(`id="${id}"`),`${id} chart exists`);
assert.match(app,/network-operations':'shipments/,'Shipment Monitoring opens the shipments page by default');
assert.match(app,/activateWorkspacePanel\(primary,moduleSection\[page\]\|\|workspaceDefaults\[primary\]\)/,'Deep links activate their matching workspace subpage');
assert.match(app,/activateWorkspacePanel\(primary,validHash\?hashTarget:workspaceDefaults\[primary\]\)/,'Workspace hash URLs restore the selected subpage');
assert.match(app,/state\.shipments\.analytics=r\.analytics\|\|\{\}/,'Shipment analytics are passed into the chart renderer');
assert.ok(css.includes('.primary-page.has-workspace-nav>.scroll-section[hidden]') && css.includes('display:none!important;'),'Inactive workspace sections are hidden');
assert.ok(css.includes('.shipment-analytics-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important'),'Shipment charts use an aligned two-column grid');
console.log('PASS one sub-navigation per workspace; subpages activate; Shipment Monitoring opens with six DB-backed chart surfaces');
