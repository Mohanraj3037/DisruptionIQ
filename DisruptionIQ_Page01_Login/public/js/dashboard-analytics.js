(() => {
  const charts = {};
  let latestData=null;
  const palette = () => { const s=getComputedStyle(document.documentElement); return ['--olive','--lime','--red','--amber','--muted','--green'].map(k=>s.getPropertyValue(k).trim()||'#777'); };
  const kill = id => { if(charts[id]){charts[id].destroy();delete charts[id];} };
  const make = (id,config) => { const el=document.getElementById(id); if(!el||!window.Chart)return;kill(id);charts[id]=new Chart(el,config); };
  const base = {responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'#171916',titleColor:'#fff',bodyColor:'#eee',padding:12}},scales:{x:{grid:{display:false},ticks:{color:'#777',font:{family:'Manrope',size:11}}},y:{grid:{color:'rgba(100,100,80,.12)'},ticks:{color:'#777',font:{family:'Manrope',size:11}}}}};
  function render(d){ if(!d||!window.Chart)return; const c=palette(), risk=(d.risk_queue||[]); const distributions=d.disruption_overview?.severity_distribution||[]; const levels=['Critical','High','Medium','Low'];
    // Ridgeline-style layered density curves from actual assessed order risk scores.
    const scoreRows=risk.map(x=>Number(x.risk)).filter(Number.isFinite);
    const groups=[['Critical',80,100],['High',60,80],['Medium',35,60],['Low',0,35]];
    const xs=Array.from({length:11},(_,i)=>i*10); const ridge=groups.map(([name,lo,hi],i)=>({label:name,data:xs.map(x=>{const count=scoreRows.filter(v=>v>=lo&&v<=hi&&Math.abs(v-x)<=10).length;return count+(3-i)*0.12;}),borderColor:c[i],backgroundColor:c[i]+'22',fill:true,tension:.42,pointRadius:0,borderWidth:2}));
    make('riskRidgelineChart',{type:'line',data:{labels:xs.map(x=>`${x}`),datasets:ridge},options:{...base,plugins:{...base.plugins,legend:{display:true,position:'bottom',labels:{usePointStyle:true,boxWidth:8,font:{family:'Manrope',size:11}}}},scales:{...base.scales,x:{...base.scales.x,title:{display:true,text:'Risk score',color:'#777'}},y:{...base.scales.y,title:{display:true,text:'Relative record density',color:'#777'}}}}});
    // Hierarchical composition represented as a nested doughnut (sunburst-like) with two rings.
    const ship=d.overview?.shipmentStatus||{}; const shipLabels=ship.labels||[]; const shipVals=ship.values||[];
    const sevVals=levels.map(l=>Number(distributions.find(x=>x.label===l)?.value||0));
    make('networkSunburstChart',{type:'doughnut',data:{labels:[...shipLabels,...levels],datasets:[{label:'Shipment state',data:shipVals,backgroundColor:shipLabels.map((_,i)=>c[i%c.length]),borderWidth:2,borderColor:'#f3eee5',weight:1},{label:'Disruption severity',data:sevVals,backgroundColor:levels.map((_,i)=>c[(i+2)%c.length]),borderWidth:2,borderColor:'#f3eee5',weight:.75}]},options:{responsive:true,maintainAspectRatio:false,cutout:'34%',plugins:{legend:{position:'bottom',labels:{usePointStyle:true,boxWidth:8,font:{family:'Manrope',size:10}}},tooltip:base.plugins.tooltip}}});
    const assessed=Number(d.order_risk?.total_affected_orders||0),unassessed=Math.max(0,Number(d.summary?.affected_customer_orders||0)-Number(d.order_risk?.total_affected_orders||0));
    make('riskCoverageChart',{type:'doughnut',data:{labels:['Assessed','Not assessed'],datasets:[{data:[assessed,unassessed],backgroundColor:[c[0],c[4]],borderWidth:3,borderColor:'#f3eee5',hoverOffset:7}]},options:{responsive:true,maintainAspectRatio:false,cutout:'72%',plugins:{legend:{position:'bottom',labels:{usePointStyle:true,boxWidth:8,font:{family:'Manrope',size:11}}},tooltip:base.plugins.tooltip}}});
  }
  window.addEventListener('diq-dashboard-loaded',e=>{latestData=e.detail;render(latestData);});
})();