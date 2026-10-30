(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const pageNames = {
    overview: 'Overview', 'hub-overview': 'Hub Management', 'hub-details': 'Hub Details', shipments: 'Shipment Management', suppliers: 'Supplier Management', warehouses: 'Warehouse & Inventory', orders: 'Customer Orders', risk: 'Intelligence Overview',
    recovery: 'Recovery Management', audit: 'Audit & Administration'
  };
  const primaryDefaults = {'overview':'overview','network-operations':'shipments','disruption-intelligence':'overview','recovery-management':'recovery','intelligence-administration':'audit'};
  const modulePrimary = {overview:'overview','hub-overview':'network-operations','hub-details':'network-operations',shipments:'network-operations',suppliers:'network-operations',warehouses:'network-operations',orders:'network-operations',risk:'intelligence-administration',recovery:'recovery-management',audit:'intelligence-administration'};
  const moduleSection = {overview:'overview-command','hub-overview':'network-hubs','hub-details':'network-hubs',shipments:'network-shipments',suppliers:'network-suppliers',warehouses:'network-warehouses',orders:'network-orders',risk:'admin-intelligence',recovery:'recovery-overview',audit:'admin-audit'};
  const state = { data: null, charts: {}, currentUser: null, indiaMap: null, indiaMapLayers: null, currentPage: 'overview', primaryPage: 'overview', toastTimer: null, hubs: {summary:null,rows:[],page:1,limit:25,total:0,totalPages:0,selected:null,filters:{q:'',status:'',health:'',disruption:''}}, hubDetails:{id:null,hub:null,active:'shipments',page:1,limit:25,total:0,totalPages:0,q:'',status:'',rows:[]}, shipments:{summary:null,analytics:null,rows:[],page:1,limit:25,total:0,totalPages:0,filters:{q:'',status:'',carrier:'',origin:'',destination:'',from:'',to:'',disruption:'',sort:'created',direction:'desc'},detail:null}, suppliers:{summary:null,rows:[],page:1,limit:25,total:0,totalPages:0,filters:{q:'',status:'',products:'',disruption:'',activity:'',sort:'name',direction:'asc'},selected:null,active:'products',detailRows:[],detailPage:1,detailTotal:0,detailTotalPages:0}, warehouses:{summary:null,rows:[],page:1,limit:25,total:0,totalPages:0,filters:{q:'',status:'',location:'',disruption:'',sort:'code',direction:'asc'},selected:null,active:'inventory',detailPage:1,detailTotal:0,detailTotalPages:0,detailQ:'',detailStatus:''}, orders:{summary:null,rows:[],page:1,limit:25,total:0,totalPages:0,filters:{q:'',status:'',risk:'',disruption:'',warehouse:'',from:'',to:'',sort:'date',direction:'desc'},selected:null,active:'items',detail:null} };
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = (value) => '$' + Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const statusClass = (status) => ['Delayed','Disrupted'].includes(status) ? 'delayed' : ['At risk','At Risk'].includes(status) ? 'risk' : '';
  const severityClass = (severity) => String(severity || '').toLowerCase();
  const toast = (message) => {
    const el = $('#toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.classList.remove('show'), 2700);
  };
  const api = async (url, options = {}) => {
    const csrfCookie = document.cookie.split(';').map(v => v.trim()).find(v => v.startsWith('diq_csrf='));
    const csrfToken = csrfCookie ? decodeURIComponent(csrfCookie.slice('diq_csrf='.length)) : '';
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? {'Content-Type':'application/json'} : {}),
        ...(csrfToken ? {'X-CSRF-Token': csrfToken} : {}),
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) { window.location.assign('/login'); throw new Error('Session expired. Please sign in again.'); }
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  };
  const loadDashboardData = async (days=Number($('#trendRange')?.value||7)) => {
    const period=Math.max(1,Math.min(30,Number(days)||7));
    const response = await api(`/api/v1/dashboard?days=${period}`);
    if (!response.success || !response.data) throw new Error(response.error || 'Dashboard data could not be loaded.');
    return response.data;
  };
  const showDashboardError = (error) => {
    $('#dashboardSignalTitle').textContent='Dashboard data unavailable';
    $('#dashboardSignalText').textContent='The latest dashboard request failed. Existing values, if present, may be stale. Use Refresh data to retry.';
    $('#lastUpdatedLabel').innerHTML='<i></i> Refresh failed';
    toast(error?.message||'Dashboard data could not be loaded.');
  };
  const chartPalette = () => {
    const css = getComputedStyle(document.documentElement);
    return { ink: css.getPropertyValue('--ink').trim(), muted: css.getPropertyValue('--muted').trim(), line: css.getPropertyValue('--line').trim(), lime: css.getPropertyValue('--lime').trim(), olive: css.getPropertyValue('--olive').trim(), red: css.getPropertyValue('--red').trim(), amber: css.getPropertyValue('--amber').trim(), green: css.getPropertyValue('--green').trim(), paper: css.getPropertyValue('--paper-2').trim() };
  };
  const destroyChart = (id) => { if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; } };
  const chartBase = () => {
    const p = chartPalette();
    return {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#171916', titleColor: '#fff', bodyColor: '#e9e7dd', padding: 11, cornerRadius: 9, displayColors: true, titleFont: { family: 'IBM Plex Mono', size: 10 }, bodyFont: { family: 'Inter', size: 11 } } },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: p.muted, font: { family: 'IBM Plex Mono', size: 9 } } },
        y: { beginAtZero: true, grid: { color: p.line, drawTicks: false }, border: { display: false }, ticks: { color: p.muted, padding: 9, font: { family: 'IBM Plex Mono', size: 9 } } }
      }
    };
  };
  const initOverviewCharts = () => {
    if (!window.Chart || !state.data) return;
    const p = chartPalette(); const o = state.data.overview;
    destroyChart('exposureGauge');
    const totalShipments=Number(state.data.summary?.total_shipments||0),deliveredShipments=Number(state.data.summary?.delivered_shipments||0);
    state.charts.exposureGauge = new Chart($('#exposureGauge'), { type: 'doughnut', data: { labels: ['Delivered', 'Remaining'], datasets: [{ data: [deliveredShipments, Math.max(0,totalShipments-deliveredShipments)], backgroundColor: [p.lime, 'rgba(255,255,255,.13)'], borderWidth: 0, borderRadius: 4, spacing: 2, cutout: '82%' }] }, options: { responsive: true, maintainAspectRatio: false, circumference: 270, rotation: 225, plugins: { legend: { display: false }, tooltip: { enabled: false } }, animation: { duration: 1000 } } });
    destroyChart('disruptionTrend');
    const trend = o.disruptionTrend;
    state.charts.disruptionTrend = new Chart($('#disruptionTrend'), { type: 'line', data: { labels: trend.labels, datasets: [
      { label: 'Detected', data: trend.detected, borderColor: p.red, backgroundColor: 'rgba(237,108,75,.09)', fill: true, tension: .38, borderWidth: 2.2, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: p.red },
      { label: 'Resolved', data: trend.resolved, borderColor: p.olive, backgroundColor: 'rgba(79,92,37,.05)', fill: true, tension: .38, borderWidth: 2, pointRadius: 2.5, pointHoverRadius: 5, pointBackgroundColor: p.olive }
    ] }, options: { ...chartBase(), plugins: { ...chartBase().plugins, tooltip: { ...chartBase().plugins.tooltip, callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y} incidents` } } }, scales: { ...chartBase().scales, y: { ...chartBase().scales.y, suggestedMax: 8, ticks: { ...chartBase().scales.y.ticks, stepSize: 2, precision: 0 } } } } });
    destroyChart('regionExposure');
    state.charts.regionExposure = new Chart($('#regionExposure'), { type: 'bar', data: { labels: o.regionalExposure.labels, datasets: [{ data: o.regionalExposure.values, backgroundColor: [p.lime, '#a4ae7b', '#c5a06b', '#7d887b'], borderRadius: 7, borderSkipped: false, barThickness: 16 }] }, options: { ...chartBase(), indexAxis: 'y', plugins: { ...chartBase().plugins, tooltip: { ...chartBase().plugins.tooltip, callbacks: { label: ctx => ` Exposure index: ${ctx.parsed.x}/100` } } }, scales: { x: { ...chartBase().scales.x, max: 100, grid: { color: p.line }, ticks: { ...chartBase().scales.x.ticks, stepSize: 25 } }, y: { ...chartBase().scales.y, grid: { display: false }, ticks: { ...chartBase().scales.y.ticks, color: p.ink } } } } });
    // Supplemental overview analytics: all values come from the current database-backed dashboard payload.
    const severityRows = state.data.disruption_overview?.severity_distribution || [];
    const severityLabels = severityRows.map(x => String(x.label || 'Unclassified'));
    const severityValues = severityRows.map(x => Number(x.value || 0));
    destroyChart('overviewRiskComposition');
    state.charts.overviewRiskComposition = new Chart($('#overviewRiskComposition'), {
      type: 'doughnut',
      data: { labels: severityLabels, datasets: [{ label: 'Recorded disruptions', data: severityValues,
        backgroundColor: [p.red, p.amber, p.olive, p.muted, p.lime], borderColor: p.paper, borderWidth: 3, hoverOffset: 9 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '62%',
        interaction: { mode: 'nearest', intersect: true },
        plugins: { legend: { display: false, position: 'bottom' }, tooltip: { enabled: true,
          callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed} recorded incidents` } } } }
    });
    const legend = $('#overviewRiskLegend');
    if (legend) legend.innerHTML = severityLabels.map((label,i) => `<span><i style="background:${[p.red,p.amber,p.olive,p.muted,p.lime][i%5]}"></i>${escapeHTML(label)} <b>${severityValues[i]}</b></span>`).join('');
    const supplierRows = (state.data.suppliers || []).filter(x => Number.isFinite(Number(x.risk))).sort((a,b)=>Number(b.risk)-Number(a.risk)).slice(0,8);
    destroyChart('overviewSupplierExposure');
    state.charts.overviewSupplierExposure = new Chart($('#overviewSupplierExposure'), {
      type: 'bar',
      data: { labels: supplierRows.map(x => String(x.name || 'Supplier').split(' ').slice(0,2).join(' ')),
        datasets: [{ label: 'Risk score', data: supplierRows.map(x => Number(x.risk)), backgroundColor: supplierRows.map(x => Number(x.risk)>=80?p.red:Number(x.risk)>=60?p.amber:p.olive), borderRadius: 7, borderSkipped: false }] },
      options: { ...chartBase(), indexAxis: 'y', interaction: { mode: 'nearest', intersect: true },
        scales: { x: { ...chartBase().scales.x, min: 0, max: 100 }, y: { ...chartBase().scales.y, grid: { display: false } } },
        plugins: { ...chartBase().plugins, tooltip: { ...chartBase().plugins.tooltip, callbacks: { label: ctx => ` Deterministic risk score: ${ctx.parsed.x}/100` } } } }
    });
  };
  const initShipmentCharts = () => {
    if (!window.Chart || !state.shipments.summary) return;
    const p=chartPalette(),s=state.shipments.summary,a=state.shipments.analytics||{};
    const make=(key,id,type,labels,datasets,options={})=>{
      const el=$(`#${id}`);if(!el)return;destroyChart(key);
      const hasValues=datasets.some(ds=>(ds.data||[]).some(v=>Number(v)>0));
      const empty=$(`#${id.replace('Chart','Empty')}`);
      if(empty)empty.classList.toggle('hidden',hasValues);
      el.classList.toggle('hidden',!hasValues);
      if(!hasValues)return;
      state.charts[key]=new Chart(el,{type,data:{labels,datasets},options:{...chartBase(),plugins:{...chartBase().plugins,legend:{display:type==='doughnut'||type==='pie',position:'bottom',labels:{usePointStyle:true,boxWidth:9,padding:16,font:{family:'Manrope',size:11}}}},...options}});
    };
    const status=a.status_distribution||[];
    make('shipmentMix','shipmentMix','doughnut',status.map(x=>x.label),[{label:'Shipments',data:status.map(x=>Number(x.value||0)),backgroundColor:[p.olive,p.lime,p.red,p.amber,p.muted],borderWidth:3,borderColor:p.paper,hoverOffset:9}],{cutout:'64%'});
    const trend=a.created_trend||[];
    make('shipmentTrend','shipmentTrendChart','line',trend.map(x=>x.label),[{label:'Shipments created',data:trend.map(x=>Number(x.value||0)),borderColor:p.olive,backgroundColor:'rgba(91,105,55,.14)',fill:true,tension:.32,borderWidth:3,pointRadius:4,pointHoverRadius:7,pointBackgroundColor:p.lime}],{plugins:{...chartBase().plugins,legend:{display:true,position:'bottom'},tooltip:{...chartBase().plugins.tooltip,callbacks:{label:ctx=>` ${ctx.parsed.y} shipment records created`}}}});
    const carriers=a.carrier_distribution||[];
    make('shipmentCarrier','shipmentCarrierChart','bar',carriers.map(x=>x.label),[{label:'All shipments',data:carriers.map(x=>Number(x.value||0)),backgroundColor:p.olive,borderRadius:7,borderSkipped:false},{label:'Delayed shipments',data:carriers.map(x=>Number(x.delayed||0)),backgroundColor:p.amber,borderRadius:7,borderSkipped:false}],{indexAxis:'y',interaction:{mode:'index',intersect:false},plugins:{...chartBase().plugins,legend:{display:true,position:'bottom'},tooltip:{...chartBase().plugins.tooltip,callbacks:{label:ctx=>` ${ctx.dataset.label}: ${ctx.parsed.x}`}}},scales:{x:{...chartBase().scales.x,beginAtZero:true,ticks:{...chartBase().scales.x.ticks,precision:0}},y:{...chartBase().scales.y,grid:{display:false}}}});
    const risk=a.risk_distribution||[];
    make('shipmentRisk','shipmentRiskChart','doughnut',risk.map(x=>x.label),[{label:'Shipments by risk score',data:risk.map(x=>Number(x.value||0)),backgroundColor:[p.red,p.amber,p.olive,p.lime],borderColor:p.paper,borderWidth:3,hoverOffset:9}],{cutout:'62%'});
    const routes=a.route_distribution||[];
    make('shipmentRoute','shipmentRouteChart','bar',routes.map(x=>`${x.origin} → ${x.destination}`),[{label:'All shipments',data:routes.map(x=>Number(x.value||0)),backgroundColor:p.olive,borderRadius:7,borderSkipped:false},{label:'Delayed shipments',data:routes.map(x=>Number(x.delayed||0)),backgroundColor:p.amber,borderRadius:7,borderSkipped:false}],{indexAxis:'y',interaction:{mode:'index',intersect:false},plugins:{...chartBase().plugins,legend:{display:true,position:'bottom'},tooltip:{...chartBase().plugins.tooltip,callbacks:{label:ctx=>` ${ctx.dataset.label}: ${ctx.parsed.x}`}}},scales:{x:{...chartBase().scales.x,beginAtZero:true,ticks:{...chartBase().scales.x.ticks,precision:0}},y:{...chartBase().scales.y,grid:{display:false},ticks:{...chartBase().scales.y.ticks,font:{family:'Manrope',size:10}}}}});
    const modes=a.transport_distribution||[];
    make('shipmentTransport','shipmentTransportChart','doughnut',modes.map(x=>x.label),[{label:'Transport mode',data:modes.map(x=>Number(x.value||0)),backgroundColor:[p.olive,p.lime,p.amber,p.red,p.muted],borderColor:p.paper,borderWidth:3,hoverOffset:9}],{cutout:'62%'});
    const destinations=a.destination_distribution||[];
    make('shipmentDestination','shipmentDestinationChart','bar',destinations.map(x=>x.label),[{label:'Shipments',data:destinations.map(x=>Number(x.value||0)),backgroundColor:destinations.map(x=>Number(x.delayed||0)?p.amber:p.olive),borderRadius:7,borderSkipped:false}],{indexAxis:'y',interaction:{mode:'nearest',intersect:false},plugins:{...chartBase().plugins,legend:{display:false},tooltip:{...chartBase().plugins.tooltip,callbacks:{label:ctx=>` ${ctx.parsed.x} shipments · ${Number(destinations[ctx.dataIndex]?.delayed||0)} delayed`}}},scales:{x:{...chartBase().scales.x,beginAtZero:true,ticks:{...chartBase().scales.x.ticks,precision:0}},y:{...chartBase().scales.y,grid:{display:false}}}});
    const modeDelay=a.mode_delay_distribution||[];
    make('shipmentModeDelay','shipmentModeDelayChart','bar',modeDelay.map(x=>x.label),[{label:'Delayed',data:modeDelay.map(x=>Number(x.delayed||0)),backgroundColor:p.amber,borderRadius:6},{label:'Delivered',data:modeDelay.map(x=>Number(x.delivered||0)),backgroundColor:p.lime,borderRadius:6}],{interaction:{mode:'index',intersect:false},plugins:{...chartBase().plugins,legend:{display:true,position:'bottom'},tooltip:{...chartBase().plugins.tooltip,callbacks:{label:ctx=>` ${ctx.dataset.label}: ${ctx.parsed.y}`}}},scales:{x:{...chartBase().scales.x},y:{...chartBase().scales.y,beginAtZero:true,ticks:{...chartBase().scales.y.ticks,precision:0}}}});
    const legend=$('#shipmentLegend');if(legend)legend.innerHTML=status.map((x,i)=>`<span><i style="background:${[p.olive,p.lime,p.red,p.amber,p.muted][i%5]}"></i>${escapeHTML(x.label)} <b>${Number(x.value||0)}</b></span>`).join('');
    const routeHost=$('#indiaRouteSummary');if(routeHost)routeHost.innerHTML=routes.length?routes.slice(0,5).map(x=>`<div class="india-route-chip"><span>${escapeHTML(x.origin)} <b>→</b> ${escapeHTML(x.destination)}</span><strong>${Number(x.value)} <small>SHIPMENTS</small></strong></div>`).join(''):'<p class="empty-state">No route pairs are currently recorded.</p>';
  };
  const initRiskChart = () => {
    if (!window.Chart || !state.data) return;
    const p = chartPalette(); destroyChart('supplierRiskChart');
    const suppliers = state.data.suppliers;
    state.charts.supplierRiskChart = new Chart($('#supplierRiskChart'), { type: 'bar', data: { labels: suppliers.map(s => s.name.split(' ').slice(0,2).join(' ')), datasets: [{ data: suppliers.map(s=>s.risk), backgroundColor: suppliers.map(s=>s.risk>=80?p.red:s.risk>=60?p.amber:p.olive), borderRadius: 6, barThickness: 16 }] }, options: { ...chartBase(), indexAxis: 'y', scales: { x: { ...chartBase().scales.x, max: 100, ticks: { ...chartBase().scales.x.ticks, stepSize: 25 } }, y: { ...chartBase().scales.y, grid: { display: false }, ticks: { ...chartBase().scales.y.ticks, color: p.ink } } } } });
  };
  const initRecoveryChart = () => {
    if (!window.Chart || !state.data || !$('#recoveryTrajectory')) return;
    const p=chartPalette(); destroyChart('recoveryTrajectory');
    const plans=state.data.recoveryPlans||[];
    state.charts.recoveryTrajectory = new Chart($('#recoveryTrajectory'), { type:'bar', data:{ labels:plans.map(x=>x.id), datasets:[{label:'Recorded completion',data:plans.map(x=>Number(x.progress||0)),backgroundColor:plans.map(x=>x.status==='Completed'?p.lime:x.status==='In progress'?p.olive:p.amber),borderRadius:6,barThickness:16}]}, options:{...chartBase(),indexAxis:'y',scales:{...chartBase().scales,x:{...chartBase().scales.x,max:100,ticks:{...chartBase().scales.x.ticks,callback:v=>`${v}%`}},y:{...chartBase().scales.y,grid:{display:false}}},plugins:{...chartBase().plugins,tooltip:{...chartBase().plugins.tooltip,callbacks:{label:ctx=>` Recorded completion: ${ctx.parsed.x}%`}}}} });
  };
  const refreshCurrentChart = () => requestAnimationFrame(() => {
    if (state.currentPage === 'overview') initOverviewCharts();
    if (state.currentPage === 'shipments') initShipmentCharts();
    if (state.currentPage === 'risk') initRiskChart();
    if (state.currentPage === 'recovery') initRecoveryChart();
  });
  const renderNetwork = () => {
    const hubs=(state.data.hub_performance||[]).filter(h=>h.shipment_count||h.active_disruptions||h.affected_orders).slice(0,6);
    $('#hubPerformanceList').innerHTML=hubs.map(h=>`
      <article class="hub-performance-row">
        <div class="hub-performance-title"><b>${escapeHTML(h.name)}</b><span>${escapeHTML(h.code)} · ${escapeHTML(h.location||'Location not specified')}</span></div>
        <div class="hub-performance-stats">
          <span><b>${Number(h.shipment_count||0)}</b> Shipments</span>
          <span><b>${Number(h.delayed_shipments||0)}</b> Delayed</span>
          <span><b>${Number(h.active_disruptions||0)}</b> Disruptions</span>
          <span><b>${Number(h.affected_orders||0)}</b> Orders</span>
        </div>
        <div class="hub-recovery-track"><i style="width:${Math.max(0,Math.min(100,Number(h.recovery_progress||0)))}%"></i></div>
        <small>${Number(h.recovery_progress||0)}% recovery actions completed · ${Number(h.completed_recovery_actions||0)}/${Number(h.recovery_actions||0)} actions</small>
      </article>`).join('')||'<p class="hub-empty">No hub performance records are available yet.</p>';
  };
  const renderPriority = () => {
    const incidents = state.data.incidents.filter(i=>!['Acknowledged','Resolved','Mitigated'].includes(i.status));
    $('#incidentCount').textContent = String(incidents.length).padStart(2,'0');
    $('#priorityList').innerHTML = incidents.slice(0,4).map(item => `
      <article class="priority-item ${severityClass(item.severity)}">
        <div class="priority-meta"><span>${escapeHTML(item.id)} · <span class="severity">${escapeHTML(item.severity.toUpperCase())}</span></span><span>${escapeHTML(item.age)}</span></div>
        <h3><button type="button" class="priority-detail-trigger" data-disruption-detail="${Number(item.backendId||0)}">${escapeHTML(item.title)}</button></h3><p>${escapeHTML(item.route)} · ${escapeHTML(item.impact)}</p><div class="disruption-detail hidden"></div>
        <button type="button" data-ack="${escapeHTML(item.id)}" ${item.status==='Acknowledged'?'disabled':''}>${item.status==='Acknowledged'?'Acknowledged':'Acknowledge'} ↗</button>
      </article>`).join('') || '<p class="empty-state">No active disruptions are recorded.</p>';
  };
  const renderOverview = () => {
    const d=state.data, o=d.overview, summary=d.summary||{};
    $('[data-metric="totalShipments"]').textContent=Number(summary.total_shipments||0).toLocaleString('en-IN');
    $('[data-metric="inTransitShipments"]').textContent=Number(summary.in_transit_shipments||0).toLocaleString('en-IN');
    $('[data-metric="deliveredShipments"]').textContent=Number(summary.delivered_shipments||0).toLocaleString('en-IN');
    $('[data-metric="activeDisruptions"]').textContent=Number(summary.active_disruptions||0).toLocaleString('en-IN');
    $('[data-metric="affectedCustomerOrders"]').textContent=Number(summary.affected_customer_orders||0).toLocaleString('en-IN');
    const severity=d.disruption_overview?.severity_distribution||[];
    const critical=Number(severity.find(x=>x.label==='Critical')?.value||0),high=Number(severity.find(x=>x.label==='High')?.value||0);
    $('#activeDisruptionSeverity').textContent=`${critical} CRITICAL · ${high} HIGH`;
    const maxSeverity=Math.max(1,...severity.map(x=>Number(x.value||0)));
    $('#activeDisruptionBars').innerHTML=severity.map(x=>`<i title="${escapeHTML(x.label)}: ${Number(x.value||0)}" style="height:${(Number(x.value||0)?Math.max(5,Math.round(Number(x.value||0)/maxSeverity*100)):0)}%"></i>`).join('');
    $$('[data-dashboard-metric]').forEach(el=>{
      const key=el.dataset.dashboardMetric;
      el.textContent=Number(summary[key]||0).toLocaleString('en-IN');
    });
    const active=Number(summary.active_disruptions||0), affected=Number(summary.affected_customer_orders||0), pending=Number(summary.pending_approvals||0);
    $('#dashboardSignalTitle').textContent=active?'Network signal requires attention':'No active disruptions detected';
    $('#dashboardSignalText').textContent=active
      ? `${active} active or investigating disruptions are linked to ${affected} distinct customer orders. ${pending} recovery decisions are awaiting approval.`
      : `No active or investigating disruptions are currently recorded. ${pending} recovery decisions are awaiting approval.`;
    $('#activeSignalCount').textContent=`${active} ACTIVE SIGNALS`;
    const updated=new Date(d.last_updated||d.updatedAt||Date.now());
    $('#lastUpdatedLabel').innerHTML=`<i></i> Updated ${updated.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'})} IST`;
    $('#hubMapCount').textContent=`${(d.hub_performance||[]).length} HUBS`;
    $('#metricAtRiskShipments').textContent=Number(d.overview?.atRiskShipments||0).toLocaleString('en-IN');
    $('#metricInventoryCoverage').textContent=`${Number(d.overview?.inventoryCoverage||0)}%`;
    $('#metricMonitoredSuppliers').textContent=Number(d.overview?.monitoredSuppliers||0).toLocaleString('en-IN');
    $('#metricNetworkUnits').textContent=Number(d.overview?.totalUnits||0).toLocaleString('en-IN');
    const coverage=Number(d.recovery_overview?.mitigation_coverage_percent||0);
    $('#recoveryCoverageBar').style.width=`${Math.max(0,Math.min(100,coverage))}%`;
    $('#recoveryCoverageValue').textContent=`${coverage}%`;
    $('#networkLastSync').textContent=`LAST SYNC ${updated.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'Asia/Kolkata'})} IST`;
    const dateStamp=$('.date-stamp');if(dateStamp)dateStamp.textContent=updated.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'Asia/Kolkata'}).toUpperCase();
    const topRegion=o.regionalExposure?.labels?.[0];
    $('#regionalExposureNote').innerHTML=`<span class="signal-dot" style="background:var(--lime)"></span> ${topRegion?`${escapeHTML(topRegion)} has the highest calculated supplier exposure.`:'Regional exposure will appear when supplier records are available.'}`;
    renderPriority();
    renderNetwork();
    $('#overviewShipments').innerHTML=d.shipments.slice(0,4).map(s=>`<tr><td class="table-id">${escapeHTML(s.id)}</td><td class="route-cell">${escapeHTML(s.route)}</td><td>${escapeHTML(s.carrier)}</td><td class="mono">${escapeHTML(s.eta)}</td><td><span class="status-pill ${statusClass(s.operationalStatus||s.status)}">${escapeHTML(s.operationalStatus||s.status)}</span></td><td class="risk-number ${s.risk>=75?'high':s.risk>=50?'medium':'low'}">${s.risk}</td></tr>`).join('')||'<tr><td colspan="6">No shipment records are available.</td></tr>';
    $('#movementList').innerHTML=(d.recent_activities||[]).slice(0,4).map(e=>{
      const time=new Date(e.timestamp);
      const label=Number.isNaN(time.getTime())?'—':time.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'});
      return `<div class="movement-item" data-route="audit" role="button" tabindex="0"><span class="movement-time">${escapeHTML(label)}</span><div><b>${escapeHTML(e.type)}</b><span>${escapeHTML(e.actor)} · ${escapeHTML(e.description)}</span></div></div>`;
    }).join('')||'<p class="empty-state">No audit activity has been recorded.</p>';
  };
  const renderShipmentPage = () => { renderShipmentSummary(); renderShipmentRegister(); };
  const shipmentFilterQuery=()=>{const f=state.shipments.filters,p=new URLSearchParams({page:String(state.shipments.page),limit:String(state.shipments.limit),sort:f.sort,direction:f.direction});Object.entries(f).forEach(([k,v])=>{if(v&&k!=='sort'&&k!=='direction')p.set(k,v);});return p.toString();};
  const renderShipmentSummary=()=>{
    const s=state.shipments.summary||{};const cards=[['TOTAL SHIPMENTS',s.total,'All recorded shipments'],['IN TRANSIT',s.in_transit,'Current database status'],['DELIVERED',s.delivered,'Marked delivered'],['DELAYED',s.delayed,'Marked delayed'],['DISRUPTION-AFFECTED',s.disruption_affected,'Active linked disruption'],['ELEVATED RISK',s.elevated_risk,'Stored risk score ≥ 60'],['AVERAGE RISK',`${Number(s.average_risk_score||0).toFixed(1)}/100`,'Average stored shipment score']];
    $('#shipmentKpis').innerHTML=cards.map(([label,value,note])=>`<article class="sub-kpi"><span>${label}</span><strong>${Number(value||0).toLocaleString('en-IN')}</strong><small>${note}</small></article>`).join('');
    const t=state.shipments.lastUpdated?new Date(state.shipments.lastUpdated):new Date();$('#shipmentUpdated').innerHTML=`<i></i> Updated ${t.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'})} IST`;
  };
  const renderShipmentRegister=()=>{
    const d=state.shipments,rows=d.rows||[];
    $('#shipmentTable').innerHTML=rows.map(x=>`<tr><td class="table-id"><button class="shipment-open-link" type="button" data-shipment-open="${x.id}">SHP-${x.id}</button></td><td class="mono">${escapeHTML(x.tracking_number||'—')}</td><td>${escapeHTML(x.carrier_name||'Not recorded')}</td><td>${escapeHTML(x.origin_warehouse_code||x.origin_city||'—')}</td><td>${escapeHTML(x.destination_warehouse_code||x.destination_city||'—')}</td><td><span class="status-pill ${statusClass(x.status)}">${escapeHTML(x.status)}</span></td><td class="mono">${escapeHTML(x.estimated_arrival||'—')}</td><td>${Number(x.disruption_count||0)?`<span class="assessment">${x.disruption_count} linked</span>`:'—'}</td></tr>`).join('')||'<tr><td colspan="8" class="empty-state">No shipment records match the selected filters.</td></tr>';
    const start=d.total?((d.page-1)*d.limit)+1:0,end=Math.min(d.total,d.page*d.limit);$('#shipmentPaginationLabel').textContent=`Showing ${start}–${end} of ${d.total} shipments`;
    $('#shipmentPrev').disabled=d.page<=1;$('#shipmentNext').disabled=d.page>=d.totalPages||!d.total;
  };
  const loadShipmentList=async()=>{const r=await api(`/api/v1/shipments?${shipmentFilterQuery()}`);if(r.success===false)throw new Error(r.error||'Shipment register request failed.');const d=state.shipments;d.rows=r.shipments||[];d.total=Number(r.total||0);d.totalPages=Number(r.total_pages||0);const filters=r.filters||{};
    const setOptions=(selector,items,label,valueFn)=>{const el=$(selector),current=el.value;el.innerHTML=`<option value="">${label}</option>`+items.map(x=>`<option value="${escapeHTML(valueFn(x))}">${escapeHTML(typeof x==='string'?x:(x.code+' · '+x.name))}</option>`).join('');if([...el.options].some(o=>o.value===current))el.value=current;};
    setOptions('#shipmentFilter',filters.statuses||[],'All statuses',x=>x);setOptions('#shipmentCarrierFilter',filters.carriers||[],'All carriers',x=>x);setOptions('#shipmentOriginFilter',filters.warehouses||[],'All origins',x=>x.id);setOptions('#shipmentDestinationFilter',filters.warehouses||[],'All destinations',x=>x.id);
    renderShipmentRegister();
  };
  const loadShipmentPage=async()=>{try{const r=await api('/api/v1/shipments/overview');if(r.success===false||!r.summary)throw new Error(r.error||'Shipment overview response was incomplete.');state.shipments.summary=r.summary||{};state.shipments.analytics=r.analytics||{};state.shipments.lastUpdated=r.last_updated;renderShipmentSummary();await loadShipmentList();initShipmentCharts();await renderIndiaNetwork();}catch(e){$('#shipmentTable').innerHTML=`<tr><td colspan="8" class="empty-state">${escapeHTML(e.message)}. Refresh to retry.</td></tr>`;const host=$('#indiaLeafletMap');if(host)host.innerHTML=`<p class="empty-state">Shipment route data could not be loaded: ${escapeHTML(e.message)}</p>`;toast(e.message);}};
  const renderIndiaNetwork=async()=>{
    const host=$('#indiaLeafletMap');if(!host)return;
    const d=await api('/api/v1/shipments/geography');
    const total=Number(d.total_shipments||0),mapped=Number(d.mapped_shipments||0),nodes=d.nodes||[],routes=d.routes||[];
    const badge=$('#indiaRouteCount');if(badge)badge.textContent=`${mapped.toLocaleString('en-IN')} / ${total.toLocaleString('en-IN')} MAPPED · ${nodes.length} CITIES`;
    const routeHost=$('#indiaRouteSummary');if(routeHost)routeHost.innerHTML=routes.length?routes.slice(0,6).map(x=>`<div class="india-route-chip"><span>${escapeHTML(x.origin)} <b>→</b> ${escapeHTML(x.destination)} <small>${x.delayed?`${x.delayed} delayed`: 'No recorded delays'}</small></span><strong>${Number(x.shipments).toLocaleString('en-IN')} <small>SHIPMENTS</small></strong></div>`).join(''):'<p class="empty-state">The database has no mappable origin-to-destination city pairs yet. Add registered city fields to shipment records.</p>';
    if(!window.L){host.innerHTML=`<div class="map-library-fallback"><b>Interactive basemap unavailable</b><p>Map tiles require an internet connection. ${nodes.length} city nodes and ${routes.length} route groups were returned by SQLite.</p><div>${nodes.map(n=>`<span>${escapeHTML(n.city)} · ${n.shipments} movements</span>`).join('')}</div></div>`;return;}
    if(!state.indiaMap){state.indiaMap=window.L.map(host,{scrollWheelZoom:false,zoomControl:true,preferCanvas:true}).setView([21.6,79.2],4.7);window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',referrerPolicy:'strict-origin-when-cross-origin'}).addTo(state.indiaMap);state.indiaMapLayers=window.L.layerGroup().addTo(state.indiaMap);}
    state.indiaMapLayers.clearLayers();
    routes.forEach(route=>{const weight=Math.max(2,Math.min(7,2+Math.log2(Number(route.shipments||1))));const line=window.L.polyline([[route.origin_lat,route.origin_lng],[route.destination_lat,route.destination_lng]],{color:Number(route.delayed)>0?'#c47b38':'#65733f',weight,opacity:.78,dashArray:'5 8',lineCap:'round'}).addTo(state.indiaMapLayers);line.bindTooltip(`${route.origin} → ${route.destination}: ${route.shipments} shipments${route.delayed?`, ${route.delayed} delayed`:''}`);line.bindPopup(`<b>${escapeHTML(route.origin)} → ${escapeHTML(route.destination)}</b><br>${Number(route.shipments)} registered shipments<br>${Number(route.delayed)} delayed<br>Average stored risk: ${Number(route.average_risk).toFixed(1)}/100`);});
    nodes.forEach(node=>{const marker=window.L.circleMarker([node.lat,node.lng],{radius:Math.max(5,Math.min(13,5+Math.sqrt(Number(node.shipments||0)))),color:'#29301d',weight:2,fillColor:Number(node.delayed)>0?'#e2a246':'#c5e92e',fillOpacity:.95}).addTo(state.indiaMapLayers);marker.bindTooltip(`${node.city} · ${node.shipments} movements`);marker.bindPopup(`<b>${escapeHTML(node.city)}</b><br>${Number(node.shipments)} shipment movements<br>${Number(node.outbound)} outbound · ${Number(node.inbound)} inbound<br>${Number(node.delayed)} delayed<br>${Number(node.warehouse_count)} active warehouses<br><small>City-centre reference coordinate; not vehicle GPS.</small>`);});
    if(nodes.length){const bounds=window.L.latLngBounds(nodes.map(n=>[n.lat,n.lng]));state.indiaMap.fitBounds(bounds.pad(.22),{maxZoom:5});}
    requestAnimationFrame(()=>state.indiaMap?.invalidateSize());
  };
  const shipmentListItem=(x,fields)=>`<div class="hub-detail-row"><b>${escapeHTML(fields[0])}</b><span>${escapeHTML(fields[1]||'—')}</span></div>`;
  const renderShipmentDetail=(r)=>{const s=r.shipment;$('#shipmentDetailTitle').textContent=`Shipment ${s.tracking_number||s.id}`;$('#shipmentDetailMeta').textContent=`${s.status} · Shipment register ID ${s.id}`;
    const cards=[['STATUS',s.status],['CARRIER',s.carrier_name||'Not recorded'],['ITEM LINES',r.items.length],['LINKED DISRUPTIONS',r.disruptions.length],['VERIFIED AFFECTED ORDERS',r.orders.length],['RECOVERY PLANS',r.recovery.length]];$('#shipmentDetailKpis').innerHTML=cards.map(([a,b])=>`<article class="sub-kpi"><span>${escapeHTML(a)}</span><strong>${escapeHTML(b)}</strong><small>Database-derived</small></article>`).join('');
    $('#shipmentDetailRoute').innerHTML=[['Origin',`${s.origin_warehouse_code||'—'} ${s.origin_warehouse_name||s.origin_city||''}`],['Destination',`${s.destination_warehouse_code||'—'} ${s.destination_warehouse_name||s.destination_city||''}`],['Transport',s.transport_mode],['Dispatch',s.actual_departure||s.estimated_departure],['Expected delivery',s.estimated_arrival],['Actual delivery',s.actual_arrival]].map(x=>shipmentListItem(null,x)).join('');
    $('#shipmentDetailItems').innerHTML=r.items.map(x=>shipmentListItem(x,[`${x.sku} · ${x.item_name}`,`Qty ${x.quantity}`])).join('')||'<p class="empty-state">No shipment item rows are recorded.</p>';
    $('#shipmentDetailDisruptions').innerHTML=r.disruptions.map(x=>shipmentListItem(x,[`${x.disruption_code} · ${x.title}`,`${x.severity} · ${x.status}`])).join('')||'<p class="empty-state">No disruptions are linked to this shipment.</p>';
    $('#shipmentDetailOrders').innerHTML=r.orders.map(x=>`<div class="hub-detail-row"><b><button class="shipment-open-link" type="button" data-order-open="${x.id}">${escapeHTML(x.order_number)}</button></b><span>${escapeHTML(`${x.status} · ${x.priority}`)}</span></div>`).join('')||'<p class="empty-state">No orders are verifiably linked through shipment disruptions.</p>';$('#shipmentOrderNote').textContent=r.order_relationship_note||'';
    $('#shipmentDetailRecovery').innerHTML=r.recovery.map(x=>shipmentListItem(x,[`${x.plan_code} · ${x.title}`,`${x.status} · ${x.completed_actions||0}/${x.action_count||0} actions completed`])).join('')||'<p class="empty-state">No recovery plans are linked to this shipment.</p>';
    $('#shipmentDetailActivities').innerHTML=r.activities.map(x=>shipmentListItem(x,[x.event_type||'Event',`${x.timestamp||''} · ${x.description||''}`])).join('')||'<p class="empty-state">No shipment-specific activity history is available.</p>';
    $('#shipmentDetailPanel').classList.remove('hidden');state.shipments.detail=s.id;
  };
  const openShipmentDetails=async(id,push=true)=>{const n=Number(id);if(!Number.isSafeInteger(n)||n<1)return;state.shipments.detail=n;if(push)history.pushState({page:'shipments',shipmentId:n},'',`/app/shipments?id=${n}`);if(state.currentPage!=='shipments')setPage('shipments',false);$('#shipmentDetailPanel').classList.remove('hidden');$('#shipmentDetailTitle').textContent='Loading shipment…';try{renderShipmentDetail(await api(`/api/v1/shipments/${n}`));}catch(e){$('#shipmentDetailTitle').textContent='Shipment unavailable';$('#shipmentDetailMeta').textContent=e.message;toast(e.message);}};
  const renderRiskPage = () => {
    const suppliers=state.data.suppliers, high=suppliers.filter(s=>s.risk>=75).length, avg=Math.round(suppliers.reduce((a,s)=>a+s.risk,0)/suppliers.length);
    $('#riskKpis').innerHTML=[['NETWORK EXPOSURE',state.data.overview.networkExposure+'/100','Weighted network index'],['HIGH-RISK SUPPLIERS',high,'Score ≥ 75'],['AVERAGE SUPPLIER RISK',avg+'/100','Across sample suppliers'],['OPEN INCIDENTS',state.data.incidents.filter(i=>i.status!=='Acknowledged').length,'Signals still active']].map(x=>`<article class="sub-kpi"><span>${x[0]}</span><strong>${x[1]}</strong><small>${x[2]}</small></article>`).join('');
    $('#supplierRegisterTable').innerHTML=suppliers.map(s=>`<tr><td class="route-cell">${escapeHTML(s.name)}</td><td>${escapeHTML(s.region)}</td><td class="risk-number ${s.risk>=75?'high':s.risk>=50?'medium':'low'}">${s.risk}/100</td><td class="mono">${s.reliability}%</td><td>${escapeHTML(s.exposure)}</td><td><span class="assessment ${s.risk<50?'low':''}">${s.risk>=75?'Elevated':s.risk>=50?'Watch':'Stable'}</span></td></tr>`).join('');
    const heat=[['Low','Low','Med','High'],['Low','Med','High','High'],['Med','Med','High','Hot'],['Med','High','Hot','Hot']];
    $('#riskMatrix').innerHTML=heat.flat().map((v,i)=>`<div class="risk-cell ${v==='Hot'?'hot':''}">${v}${[3,6,11,15].includes(i)?'<span></span>':''}</div>`).join('');
  };
  const renderRecoveryPage = () => {
    const plans=state.data.recoveryPlans; const completed=plans.filter(p=>p.status==='Completed').length, progress=plans.filter(p=>p.status==='In progress').length, awaiting=plans.filter(p=>['Awaiting approval','Planned'].includes(p.status)).length;
    $('#completedCount').textContent=completed; $('#inProgressCount').textContent=progress; $('#awaitingCount').textContent=awaiting;
    const coverage=plans.length?Math.round(completed/plans.length*100):0;$('#recoveryCoverage').innerHTML=`${coverage}<span>%</span>`;
    const value=plans.reduce((a,p)=>a+p.value,0);
    $('#recoveryKpis').innerHTML=[['IDENTIFIED VALUE',money(value),'Across current recovery plans'],['PLANS IN MOTION',progress,'Execution underway'],['AWAITING DECISION',awaiting,'Approval or scheduling'],['COMPLETED',completed,'Closed actions']].map(x=>`<article class="sub-kpi"><span>${x[0]}</span><strong>${x[1]}</strong><small>${x[2]}</small></article>`).join('');
    const columns=[['Planned','Planned'],['In progress','In progress'],['Awaiting approval','Awaiting approval'],['Completed','Completed']];
    $('#recoveryBoard').innerHTML=columns.map(([status,label])=>{const list=plans.filter(p=>p.status===status);return `<section class="recovery-column"><div class="recovery-column-head"><span>${label.toUpperCase()}</span><b>${list.length}</b></div>${list.map(p=>`<article class="plan-card"><small>${escapeHTML(p.id)} · ${escapeHTML(p.priority.toUpperCase())}</small><h3>${escapeHTML(p.title)}</h3><p>${escapeHTML(p.owner)} · Due ${escapeHTML(p.due)}</p><div class="plan-progress"><i style="width:${p.progress}%"></i></div><div class="plan-card-foot"><span>${p.progress}% COMPLETE</span><b>${money(p.value)}</b></div></article>`).join('')||'<div class="plan-card"><p>No actions in this lane.</p></div>'}</section>`}).join('');
  };
  const renderAuditPage = () => {
    const count=$('#auditRecordCount');if(count)count.textContent=hubCount(state.data.auditTrail.length);
    const table=$('#auditTable');if(table)table.innerHTML=state.data.auditTrail.map(e=>`<tr><td class="mono">${escapeHTML(e.time)}</td><td>${escapeHTML(e.actor)}</td><td class="route-cell">${escapeHTML(e.action)}</td><td>${escapeHTML(e.target)}</td><td><span class="assessment low">${escapeHTML(e.kind)}</span></td></tr>`).join('')||'<tr><td colspan="5" class="empty-state">No application actions have been recorded yet.</td></tr>';
  };
  const hubCount=(v)=>Number(v||0).toLocaleString('en-IN');
  const hubStatusClass=(v)=>String(v||'').toLowerCase().replace(/[^a-z]+/g,'-');
  const hubQuery=()=>{const p=new URLSearchParams({page:String(state.hubs.page),limit:String(state.hubs.limit)});Object.entries(state.hubs.filters).forEach(([k,v])=>{if(v)p.set(k,v);});return p.toString();};
  const loadHubList=async()=>{const r=await api(`/api/v1/hubs?${hubQuery()}`);state.hubs.rows=r.hubs||[];state.hubs.total=Number(r.total||0);state.hubs.totalPages=Number(r.total_pages||0);renderHubTable();};
  const renderHubSummary=()=>{
    const s=state.hubs.summary||{};const cards=[['TOTAL HUBS',s.total_hubs,'Warehouse records'],['ACTIVE HUBS',s.active_hubs,'Active warehouse status'],['TOTAL SHIPMENTS',s.total_shipments,'Distinct shipment records'],['DELAYED SHIPMENTS',s.delayed_shipments,'Current delayed status'],['ACTIVE DISRUPTIONS',s.active_disruptions,'Active or investigating'],['AFFECTED ORDERS',s.affected_customer_orders,'Distinct linked orders'],['LOW / OUT OF STOCK',Number(s.low_stock_products||0)+Number(s.out_of_stock_products||0),'Distinct product alerts'],['RECOVERY ACTIONS',s.recovery_actions_in_progress,'In progress or executing']];
    $('#hubSummaryKpis').innerHTML=cards.map(([label,value,note])=>`<article class="sub-kpi"><span>${label}</span><strong>${hubCount(value)}</strong><small>${note}</small></article>`).join('');
    const h=state.hubs.health||{};$('#hubHealthBreakdown').innerHTML=[['HEALTHY',h.healthy||0,'healthy'],['WATCH',h.watch||0,'watch'],['CRITICAL',h.critical||0,'critical']].map(([label,value,cls])=>`<div class="hub-health-item"><span class="hub-health-dot ${cls}"></span><b>${label}</b><strong>${hubCount(value)}</strong></div>`).join('')||'<p class="empty-state">No hub health data available.</p>';
    $('#hubInventorySummary').innerHTML=[['TRACKED INVENTORY ITEMS',s.inventory_tracked_items],['AVAILABLE STOCK UNITS',s.available_stock_units],['LOW-STOCK PRODUCTS',s.low_stock_products],['OUT-OF-STOCK PRODUCTS',s.out_of_stock_products],['ORDERS WITH STOCK SHORTAGES',s.stock_shortage_orders]].map(([label,value])=>`<div><span>${label}</span><b>${hubCount(value)}</b></div>`).join('');
    const t=state.hubs.lastUpdated?new Date(state.hubs.lastUpdated):new Date();$('#hubUpdatedLabel').innerHTML=`<i></i> Updated ${t.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'})} IST`;
  };
  const renderHubTable=()=>{
    const rows=state.hubs.rows||[];$('#hubTable').innerHTML=rows.map(h=>{const stock=Number(h.inventory.low_stock_products||0)+Number(h.inventory.out_of_stock_products||0);return `<tr class="hub-table-row"><td><button class="hub-open-link" type="button" data-hub-open="${h.id}"><b>${escapeHTML(h.hub_name)}</b><small>${escapeHTML(h.hub_code)} · ID ${h.hub_id}</small></button></td><td>${escapeHTML(h.location||'Not recorded')}</td><td><span class="assessment ${h.is_active?'low':''}">${escapeHTML(h.status)}</span></td><td><span class="hub-health-pill ${hubStatusClass(h.health_status)}">${escapeHTML(h.health_status)}</span></td><td><button class="hub-metric-link" type="button" data-hub-open="${h.id}">${hubCount(h.shipment.total)}</button></td><td>${hubCount(h.shipment.delayed)}</td><td><button class="hub-metric-link" type="button" data-hub-open="${h.id}">${hubCount(h.disruptions.total)}</button></td><td><button class="hub-metric-link" type="button" data-hub-open="${h.id}">${hubCount(h.disruptions.affected_orders)}</button></td><td><button class="hub-metric-link" type="button" data-hub-open="${h.id}">${hubCount(stock)} <small>(${hubCount(h.inventory.out_of_stock_products)} out)</small></button></td><td><button class="hub-metric-link" type="button" data-hub-open="${h.id}">${hubCount(h.recovery.actions_in_progress)} active / ${hubCount(h.recovery.completed_actions)} done</button></td></tr>`;}).join('')||'<tr><td colspan="10" class="empty-state">No warehouse-backed hubs match the selected filters.</td></tr>';
    const start=state.hubs.total?((state.hubs.page-1)*state.hubs.limit)+1:0,end=Math.min(state.hubs.total,state.hubs.page*state.hubs.limit);$('#hubPaginationLabel').textContent=`Showing ${start}–${end} of ${state.hubs.total} hubs`;
    $('#hubPrevPage').disabled=state.hubs.page<=1;$('#hubNextPage').disabled=state.hubs.page>=state.hubs.totalPages||state.hubs.totalPages===0;
  };
  const hubDetailConfig={
    shipments:{title:'Shipments & movement',subtitle:'Shipments where this warehouse is the origin or destination.',columns:[['tracking_number','TRACKING NUMBER'],['status','STATUS'],['origin_warehouse_name','ORIGIN'],['destination_warehouse_name','DESTINATION'],['carrier','CARRIER'],['estimated_arrival','EXPECTED DELIVERY'],['actual_arrival','ACTUAL DELIVERY'],['disruption_count','DISRUPTIONS'],['associated_order_count','AFFECTED ORDERS']]},
    disruptions:{title:'Disruptions & incidents',subtitle:'Disruptions linked directly to this warehouse, its shipments or its inventory.',columns:[['disruption_code','DISRUPTION'],['title','TITLE'],['disruption_type','TYPE'],['severity','SEVERITY'],['status','STATUS'],['detected_at','DETECTED'],['tracking_number','SHIPMENT'],['affected_orders','AFFECTED ORDERS'],['recovery_actions_in_progress','ACTIONS IN PROGRESS']]},
    inventory:{title:'Inventory & stock',subtitle:'Inventory rows physically assigned to this warehouse. Available quantity excludes reservations.',columns:[['sku','SKU'],['item_name','PRODUCT'],['quantity','ON HAND'],['reserved_quantity','RESERVED'],['available_quantity','AVAILABLE'],['reorder_point','REORDER POINT'],['stock_status','STOCK STATUS'],['shortage_order_count','SHORTAGE ORDERS']]},
    orders:{title:'Affected customer orders',subtitle:'Orders assigned to this warehouse or linked through a verified disruption relationship. Customer personal details are excluded.',columns:[['order_number','ORDER'],['order_date','ORDER DATE'],['status','STATUS'],['priority','PRIORITY'],['delivery_deadline','DELIVERY DEADLINE'],['assigned_warehouse_code','ASSIGNED HUB'],['risk_classification','RISK'],['disruption_codes','LINKED DISRUPTIONS']]},
    recovery:{title:'Recovery plans & actions',subtitle:'Recovery plans, approval state and actual action execution records linked to this hub.',columns:[['plan_code','PLAN'],['title','RECOVERY PLAN'],['status','PLAN STATUS'],['approval_status','APPROVAL'],['action_description','ACTION'],['action_status','ACTION STATUS'],['action_executed_at','EXECUTED AT'],['completed_actions','COMPLETED ACTIONS']]},
    activities:{title:'Hub activity timeline',subtitle:'Newest operational audit events linked to this warehouse and its verified records.',columns:[['timestamp','TIMESTAMP'],['type','EVENT'],['description','DESCRIPTION'],['entity_type','ENTITY'],['entity_id','RECORD ID'],['actor','ACTOR']]}
  };
  const hubDetailStatuses={shipments:['In Transit','Delivered','Delayed','Cancelled'],disruptions:['Active','Investigating','Mitigated','Resolved'],inventory:['Available','Low stock','Out of stock'],orders:['Pending','Processing','Shipped','Delivered','Cancelled'],recovery:['Draft','Pending Approval','Approved','Execution Ready','Executing','Completed','Failed'],activities:[]};
  const renderHubDetailTable=()=>{
    const d=state.hubDetails,config=hubDetailConfig[d.active];if(!config)return;
    $('#hubDetailsSectionTitle').textContent=config.title;$('#hubDetailsSectionSubtitle').textContent=config.subtitle;
    $('#hubDetailsTableHead').innerHTML=`<tr>${config.columns.map(c=>`<th>${escapeHTML(c[1])}</th>`).join('')}</tr>`;
    $('#hubDetailsTableBody').innerHTML=(d.rows||[]).map(row=>`<tr>${config.columns.map(([key])=>{let value=row[key];if(value===null||value===undefined||value==='')value='—';if(key==='disruption_codes'&&value!=='—')value=String(value).split(',').join(', ');if(d.active==='shipments'&&key==='tracking_number')return `<td><button class="shipment-open-link" type="button" data-shipment-open="${row.id}">${escapeHTML(value)}</button></td>`;if(d.active==='orders'&&key==='order_number')return `<td><button class="shipment-open-link" type="button" data-order-open="${row.id}">${escapeHTML(value)}</button></td>`;return `<td>${escapeHTML(value)}</td>`;}).join('')}</tr>`).join('')||`<tr><td colspan="${config.columns.length}" class="empty-state">No ${escapeHTML(d.active)} records are linked to this hub.</td></tr>`;
    $('#hubDetailsPaginationLabel').textContent=d.total?`Showing ${(d.page-1)*d.limit+1}–${Math.min(d.page*d.limit,d.total)} of ${d.total} records`:'No records';
    $('#hubDetailsPrev').disabled=d.page<=1;$('#hubDetailsNext').disabled=d.page>=d.totalPages;
    $('#hubDetailsSearch').value=d.q;$('#hubDetailsStatus').value=d.status;
    $$('#page-hub-details [data-hub-tab]').forEach(b=>b.classList.toggle('active',b.dataset.hubTab===d.active));
  };
  const loadHubDetailCollection=async()=>{
    const d=state.hubDetails;const params=new URLSearchParams({page:String(d.page),limit:String(d.limit)});if(d.q)params.set('q',d.q);if(d.status)params.set('status',d.status);
    $('#hubDetailsTableBody').innerHTML='<tr><td>Loading linked records…</td></tr>';
    const r=await api(`/api/v1/hubs/${d.id}/${d.active}?${params}`);d.rows=r.items||[];d.total=Number(r.total||0);d.totalPages=Number(r.total_pages||0);renderHubDetailTable();
  };
  const loadHubDetailsPage=async(id)=>{
    const d=state.hubDetails;if(id)d.id=Number(id);
    $('#hubDetailsName').textContent='Loading hub…';$('#hubDetailsMeta').textContent='Retrieving warehouse-backed records from SQLite.';$('#hubDetailsTableBody').innerHTML='<tr><td>Loading hub details…</td></tr>';
    try{
      // Direct links without ?id= should resolve to the first real warehouse-backed hub.
      if(!Number.isSafeInteger(d.id)||d.id<1){const list=await api('/api/v1/hubs?page=1&limit=1');d.id=Number(list.hubs?.[0]?.id||0);}
      if(!Number.isSafeInteger(d.id)||d.id<1){$('#hubDetailsName').textContent='No warehouse-backed hubs found';$('#hubDetailsMeta').textContent='Create or import a warehouse record before opening hub details.';$('#hubDetailsTableBody').innerHTML='<tr><td class="empty-state">No hub records are available.</td></tr>';$('#hubDetailsKpis').innerHTML='';return;}
      const r=await api(`/api/v1/hubs/${d.id}`);const h=r.hub;if(!h)throw new Error('The selected hub was not returned by the API.');d.hub=h;state.hubs.selected=h;
      $('#hubDetailsHeading').innerHTML=`${escapeHTML(h.hub_name)} <em>details.</em>`;$('#hubDetailsName').textContent=`${h.hub_name} · ${h.hub_code}`;$('#hubDetailsSubtitle').textContent=`Warehouse ID ${h.id} · ${h.location||'Location not recorded'}`;
      $('#hubDetailsMeta').textContent=`${h.status} · ${h.health_status} operational health`;$('#hubDetailsHealth').textContent=h.health_status;$('#hubDetailsHealth').className=`hub-health-pill ${hubStatusClass(h.health_status)}`;
      const cards=[['TOTAL SHIPMENTS',h.shipment.total],['IN TRANSIT',h.shipment.in_transit],['DELIVERED',h.shipment.delivered],['DELAYED',h.shipment.delayed],['ACTIVE DISRUPTIONS',h.disruptions.total],['AFFECTED ORDERS',h.disruptions.affected_orders],['INVENTORY RECORDS',h.inventory.tracked_items],['RECOVERY PLANS',h.recovery.plans],['PENDING APPROVALS',h.recovery.pending_approvals],['ACTIONS IN PROGRESS',h.recovery.actions_in_progress],['COMPLETED ACTIONS',h.recovery.completed_actions]];
      $('#hubDetailsKpis').innerHTML=cards.map(([label,value])=>`<article class="sub-kpi"><span>${label}</span><strong>${hubCount(value)}</strong><small>Database-derived</small></article>`).join('');
      $('#hubDetailsRelationship').textContent=`${h.relationship_notes.shipment_association} ${h.relationship_notes.order_association} ${h.relationship_notes.disruption_association} ${h.relationship_notes.inventory_association}`;
      const updated=new Date();$('#hubDetailsUpdated').innerHTML=`<i></i> Updated ${updated.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'})} IST`;
      const opts=hubDetailStatuses[d.active]||[];$('#hubDetailsStatus').innerHTML='<option value="">All statuses</option>'+opts.map(x=>`<option value="${escapeHTML(x.toLowerCase())}">${escapeHTML(x)}</option>`).join('');
      await loadHubDetailCollection();
    }catch(error){$('#hubDetailsName').textContent='Hub details unavailable';$('#hubDetailsMeta').textContent=error.message;$('#hubDetailsTableBody').innerHTML=`<tr><td class="empty-state">${escapeHTML(error.message)}</td></tr>`;toast(error.message);}
  };
  const openHubDetails=(id)=>{state.hubDetails.id=Number(id);state.hubDetails.page=1;state.hubDetails.q='';state.hubDetails.status='';state.hubDetails.active='shipments';history.pushState({page:'hub-details',hubId:Number(id)},'',`/app/hub-details?id=${Number(id)}`);setPage('hub-details',false);};
  const loadHubMonitoring=async()=>{
    try{const r=await api('/api/v1/hubs/overview');state.hubs.summary=r.summary||{};state.hubs.health=r.health_distribution||{};state.hubs.lastUpdated=r.last_updated;renderHubSummary();await loadHubList();return true;}
    catch(error){$('#hubSummaryKpis').innerHTML='<article class="sub-kpi"><span>HUB DATA</span><strong>Unavailable</strong><small>Use Refresh hubs to retry</small></article>';$('#hubTable').innerHTML=`<tr><td colspan="10" class="empty-state">${escapeHTML(error.message)}</td></tr>`;toast(error.message);return false;}
  };
  const supplierQuery=()=>{const f=state.suppliers.filters,p=new URLSearchParams({page:String(state.suppliers.page),limit:String(state.suppliers.limit),sort:f.sort,direction:f.direction});Object.entries(f).forEach(([k,v])=>{if(v)p.set(k,v);});return p.toString();};
  const renderSupplierSummary=()=>{const s=state.suppliers.summary||{};const cards=[['TOTAL SUPPLIERS',s.total],['ACTIVE SUPPLIERS',s.active],['INACTIVE SUPPLIERS',s.inactive],['WITH DISRUPTIONS',s.with_disruptions],['WITH LINKED SHIPMENTS',s.with_shipments]];$('#supplierKpis').innerHTML=cards.map(([l,v])=>`<article class="sub-kpi"><span>${l}</span><strong>${hubCount(v)}</strong><small>Database-derived</small></article>`).join('');const ds=state.suppliers.disruptionStatus||[];$('#supplierDisruptionSummary').innerHTML=ds.length?ds.map(x=>`<div class="supplier-disruption-stat"><span>${escapeHTML(x.status)}</span><strong>${hubCount(x.count)}</strong></div>`).join(''):'<p class="empty-state">No supplier-related disruptions are recorded.</p>';};
  const initSupplierCharts=()=>{if(!window.Chart||!state.suppliers.shipmentStatus)return;const p=chartPalette(),rows=state.suppliers.shipmentStatus,labels=rows.map(x=>x.status),values=rows.map(x=>Number(x.count));destroyChart('supplierShipmentChart');$('#supplierShipmentChart').classList.toggle('hidden',!values.some(Boolean));$('#supplierShipmentEmpty').classList.toggle('hidden',values.some(Boolean));if(!values.some(Boolean))return;const colors=labels.map(x=>x==='Delivered'?p.lime:x==='Delayed'?p.red:x==='In Transit'?p.olive:p.muted);state.charts.supplierShipmentChart=new Chart($('#supplierShipmentChart'),{type:'doughnut',data:{labels,datasets:[{data:values,backgroundColor:colors,borderWidth:4,borderColor:p.paper,hoverOffset:5}]},options:{responsive:true,maintainAspectRatio:false,cutout:'68%',plugins:{legend:{display:false},tooltip:chartBase().plugins.tooltip}}});$('#supplierShipmentLegend').innerHTML=labels.map((x,i)=>`<span><i style="background:${colors[i]}"></i>${escapeHTML(x)} <b>${values[i]}</b></span>`).join('');};
  const loadSupplierList=async()=>{const r=await api(`/api/v1/suppliers?${supplierQuery()}`),d=state.suppliers;d.rows=r.suppliers||[];d.total=Number(r.total||0);d.totalPages=Number(r.total_pages||0);$('#supplierRegisterTable').innerHTML=d.rows.length?d.rows.map(x=>`<tr><td class="mono">${x.id}</td><td class="route-cell">${escapeHTML(x.name)}</td><td class="mono">${escapeHTML(x.code)}</td><td>${escapeHTML([x.city,x.state,x.country].filter(Boolean).join(', ')||'—')}</td><td>${hubCount(x.product_count)}</td><td>${hubCount(x.shipment_count)}</td><td>${hubCount(x.disruption_count)}</td><td><span class="assessment ${x.is_active?'low':''}">${x.is_active?'Active':'Inactive'}</span></td><td><button class="action-button" type="button" data-supplier-open="${x.id}">View details ↗</button></td></tr>`).join(''):`<tr><td colspan="9" class="empty-state">${d.total?'No suppliers match these filters.':'No supplier records are available.'}</td></tr>`;$('#supplierPaginationLabel').textContent=`${d.total?((d.page-1)*d.limit+1):0}–${Math.min(d.page*d.limit,d.total)} of ${d.total} suppliers`;$('#supplierPrev').disabled=d.page<=1;$('#supplierNext').disabled=d.page>=d.totalPages;};
  const loadSupplierPage=async()=>{try{const r=await api('/api/v1/suppliers/overview');state.suppliers.summary=r.summary||{};state.suppliers.shipmentStatus=r.shipment_status||[];state.suppliers.disruptionStatus=r.disruption_status||[];renderSupplierSummary();initSupplierCharts();$('#supplierUpdated').innerHTML=`<i></i> Updated ${new Date(r.last_updated||Date.now()).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'})} IST`;await loadSupplierList();if(state.suppliers.selected)await loadSupplierDetail(state.suppliers.selected,false);}catch(e){$('#supplierKpis').innerHTML=`<article class="sub-kpi"><span>SUPPLIER DATA</span><strong>Unavailable</strong><small>${escapeHTML(e.message)}</small></article>`;$('#supplierRegisterTable').innerHTML=`<tr><td colspan="8" class="empty-state">${escapeHTML(e.message)}. Refresh to retry.</td></tr>`;toast(e.message);}};
  const supplierTabs={products:[['SKU','PRODUCT NAME','CATEGORY','LINKED SHIPMENTS','SHIPPED QTY'],['sku','name','category','linked_shipments','shipped_quantity']],shipments:[['SHIPMENT','TRACKING','CARRIER','ORIGIN','DESTINATION','STATUS','EXPECTED DELIVERY'],['id','tracking_number','carrier_name','origin_warehouse_code','destination_warehouse_code','status','estimated_arrival']],disruptions:[['DISRUPTION','TYPE','SEVERITY','STATUS','LINKED SHIPMENT','AFFECTED ORDERS','ORDER LINKS','DETECTED'],['disruption_code','disruption_type','severity','status','tracking_number','affected_orders','affected_order_ids','detected_at']],recovery:[['PLAN','STRATEGY','STATUS','DISRUPTION','ACTIONS','ACTION DETAILS','CREATED'],['plan_code','strategy_type','status','disruption_code','action_count','actions','created_at']],activities:[['TIME','ACTIVITY','DESCRIPTION','ENTITY','ACTOR'],['timestamp','event_type','description','entity_type','actor_name']]};
  const loadSupplierDetailCollection=async()=>{const d=state.suppliers,id=d.selected,type=d.active;$('#supplierDetailBody').innerHTML='<tr><td>Loading linked records…</td></tr>';const r=await api(`/api/v1/suppliers/${id}/${type}?page=${d.detailPage}&limit=10`);const rows=r.items||r[type]||[];d.detailRows=rows;d.detailTotal=Number(r.total||rows.length);d.detailTotalPages=Number(r.total_pages||0);const [heads,keys]=supplierTabs[type];$('#supplierDetailHead').innerHTML=`<tr>${heads.map(h=>`<th>${h}</th>`).join('')}</tr>`;$('#supplierDetailBody').innerHTML=rows.length?rows.map(x=>`<tr>${keys.map(k=>{let v=x[k];if(k==='actions')v=(v||[]).map(a=>`${a.action_sequence}. ${a.description} [${a.status}]`).join(' · ')||'No recorded actions';if(k==='affected_order_ids')return `<td>${v?String(v).split(',').map(id=>`<button class="shipment-open-link" type="button" data-order-open="${Number(id)}">ORD-${Number(id)}</button>`).join(' '):'No linked orders'}</td>`;if(k==='id'&&type==='shipments')return `<td><button class="action-button" data-supplier-shipment="${x.id}" type="button">SHP-${x.id}</button></td>`;if(k==='tracking_number')return `<td class="mono">${escapeHTML(v||'—')}</td>`;if(k==='timestamp'||k==='detected_at'||k==='created_at'||k==='estimated_arrival')v=v?new Date(v).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'—';return `<td>${escapeHTML(v??'—')}</td>`;}).join('')}</tr>`).join(''):`<tr><td colspan="${heads.length}" class="empty-state">No ${type} records are linked to this supplier.</td></tr>`;$('#supplierDetailPaginationLabel').textContent=`${d.detailTotal?((d.detailPage-1)*10+1):0}–${Math.min(d.detailPage*10,d.detailTotal)} of ${d.detailTotal} ${type}`;$('#supplierDetailPrev').disabled=d.detailPage<=1;$('#supplierDetailNext').disabled=d.detailPage>=d.detailTotalPages;$('#supplierRelationshipNote').textContent=type==='products'?'Products are associated through shipment items on shipments assigned to this supplier. No direct supplier-product foreign key exists.':type==='disruptions'?'Disruptions are included only when explicitly sourced to this supplier or linked to one of its shipments.':type==='activities'?'Only existing audit records for this supplier and its verified linked shipments or disruptions are shown.':'';};
  const loadSupplierDetail=async(id,push=true)=>{const n=Number(id);if(!Number.isSafeInteger(n)||n<1)return;const d=state.suppliers;d.selected=n;d.detailPage=1;d.detailQ='';d.detailStatus='';$('#warehouseDetailSearch').value='';$('#warehouseDetailStatus').value='';if(push)history.pushState({page:'suppliers',supplierId:n},'',`/app/suppliers/${n}`);$('#supplierDetailPanel').classList.remove('hidden');$('#supplierDetailTitle').textContent='Loading supplier…';try{const r=await api(`/api/v1/suppliers/${n}`),s=r.supplier,p=r.performance||{};$('#supplierDetailTitle').textContent=`${s.name} · supplier details`;$('#supplierDetailMeta').textContent=`${s.code} · Supplier record`;const profile=[['SUPPLIER ID',s.id],['SUPPLIER CODE',s.code],['LOCATION',[s.city,s.state,s.country].filter(Boolean).join(', ')||'Not recorded'],['CONTACT',s.contact_email||'Not recorded'],['REGION',s.region||'Not recorded'],['STATUS',s.is_active?'Active':'Inactive'],['CREATED',s.created_at?new Date(s.created_at).toLocaleDateString('en-IN'):'Not recorded'],['RECORD TYPE','Supplier']];$('#supplierProfile').innerHTML=profile.map(([a,b])=>`<div class="supplier-profile-item"><span>${a}</span><b>${escapeHTML(b)}</b></div>`).join('');const cards=[['TOTAL SHIPMENTS',p.total_shipments],['DELIVERED',p.delivered],['DELAYED',p.delayed],['IN TRANSIT',p.in_transit],['AFFECTED SHIPMENTS',p.disruption_affected_shipments],['LINKED PRODUCTS',p.linked_products],['LINKED DISRUPTIONS',p.linked_disruptions],['RECOVERY PLANS',p.recovery_plans]];$('#supplierDetailKpis').innerHTML=cards.map(([a,b])=>`<article class="sub-kpi"><span>${a}</span><strong>${hubCount(b)}</strong><small>Verified relationship</small></article>`).join('');d.active='products';$$('[data-supplier-tab]').forEach(x=>x.classList.toggle('active',x.dataset.supplierTab==='products'));await loadSupplierDetailCollection();}catch(e){$('#supplierDetailTitle').textContent='Supplier unavailable';$('#supplierDetailMeta').textContent=e.message;$('#supplierDetailBody').innerHTML=`<tr><td class="empty-state">${escapeHTML(e.message)}</td></tr>`;toast(e.message);}};
  const openSupplierDetails=id=>{setPage('suppliers',false);loadSupplierDetail(id,true);};
  const renderAll = () => { renderOverview(); renderShipmentPage(); renderRiskPage(); renderRecoveryPage(); renderAuditPage(); window.dispatchEvent(new CustomEvent('diq-dashboard-loaded',{detail:state.data})); };
  const positionGlider = () => {
    const active=$('.nav-link.active'); const nav=$('#mainNav'); const glider=$('#navGlider'); if(!active||!nav||!glider)return;
    const navBox=nav.getBoundingClientRect(), linkBox=active.getBoundingClientRect();
    glider.style.width=`${linkBox.width}px`; glider.style.transform=`translateX(${linkBox.left-navBox.left+nav.scrollLeft-5}px)`; if(window.innerWidth<760){const target=active.offsetLeft-active.offsetWidth/2-nav.clientWidth/2;nav.scrollTo({left:Math.max(0,target),behavior:'smooth'});}
  };
  const warehouseTabs={inventory:{head:['ID','SKU','PRODUCT','AVAILABLE','RESERVED','TOTAL','REORDER POINT','STATUS','UPDATED'],keys:['id','sku','product_name','available_quantity','reserved_quantity','quantity','reorder_point','stock_status','updated_at']},shipments:{head:['SHIPMENT','TRACKING','STATUS','CARRIER','ORIGIN','DESTINATION','ITEMS','EXPECTED ARRIVAL'],keys:['id','tracking_number','status','carrier','origin_warehouse_code','destination_warehouse_code','item_count','estimated_arrival']},disruptions:{head:['CODE','DISRUPTION','TYPE','SEVERITY','STATUS','SHIPMENT','AFFECTED ORDERS','DETECTED'],keys:['disruption_code','title','disruption_type','severity','status','tracking_number','affected_orders','detected_at']},orders:{head:['ORDER ID','ORDER','STATUS','PRIORITY','ORDER DATE','DEADLINE','WAREHOUSE'],keys:['id','order_number','status','priority','order_date','delivery_deadline','assigned_warehouse_id']},recovery:{head:['PLAN','TITLE','STRATEGY','STATUS','DISRUPTION','ACTIONS','CREATED'],keys:['plan_code','title','strategy_type','status','disruption_code','action_count','created_at']},activities:{head:['TIME','ACTIVITY','DESCRIPTION','ENTITY','ENTITY ID','ACTOR'],keys:['timestamp','event_type','description','entity_type','entity_id','actor_name']}};
  const renderInventoryKpis=()=>{const s=state.warehouses.summary||{};const cards=[['TOTAL WAREHOUSES',s.total_warehouses,'Warehouse records'],['ACTIVE WAREHOUSES',s.active_warehouses,'Marked active'],['INVENTORY RECORDS',s.inventory_records,'Distinct stock rows'],['TRACKED PRODUCTS',s.tracked_products,'Distinct SKUs'],['LOW STOCK',s.low_stock_records,'At or below reorder point'],['OUT OF STOCK',s.out_of_stock_records,'Zero available units']];$('#inventoryKpis').innerHTML=cards.map(([a,b,c])=>`<article class="sub-kpi"><span>${a}</span><strong>${hubCount(b)}</strong><small>${c}</small></article>`).join('');};
  const initInventoryCharts=()=>{if(!window.Chart||!state.warehouses.summary)return;const p=chartPalette(),s=state.warehouses.summary;destroyChart('inventoryStock');destroyChart('warehouseFootprint');const stock=s.stock_distribution||[];if(stock.length){$('#inventoryChartEmpty').classList.add('hidden');state.charts.inventoryStock=new Chart($('#inventoryStockChart'),{type:'doughnut',data:{labels:stock.map(x=>x.status),datasets:[{data:stock.map(x=>x.count),backgroundColor:[p.red,p.amber,p.lime],borderWidth:3,borderColor:p.paper,hoverOffset:4}]},options:{responsive:true,maintainAspectRatio:false,cutout:'68%',plugins:{legend:{position:'bottom',labels:{color:p.muted,font:{family:'IBM Plex Mono',size:9},boxWidth:8}}}}});}else $('#inventoryChartEmpty').classList.remove('hidden');const footprint=(s.warehouse_inventory||[]).filter(x=>Number(x.records)>0).sort((a,b)=>Number(b.records)-Number(a.records)||String(a.code).localeCompare(String(b.code))).slice(0,12);if(footprint.length){$('#warehouseFootprintEmpty').classList.add('hidden');state.charts.warehouseFootprint=new Chart($('#warehouseFootprintChart'),{type:'bar',data:{labels:footprint.map(x=>x.code),datasets:[{label:'Inventory records',data:footprint.map(x=>x.records),backgroundColor:p.olive,borderRadius:6}]},options:{...chartBase(),plugins:{...chartBase().plugins,legend:{display:false}}}});}else $('#warehouseFootprintEmpty').classList.remove('hidden');};
  const loadWarehouseList=async()=>{const r=await api(`/api/v1/warehouses?${new URLSearchParams({page:state.warehouses.page,limit:state.warehouses.limit,...state.warehouses.filters})}`);const d=state.warehouses;d.rows=r.warehouses||[];d.total=r.total;d.totalPages=r.total_pages;$('#warehouseTable').innerHTML=d.rows.length?d.rows.map(w=>`<tr><td class="mono">${escapeHTML(w.code)}</td><td><b>${escapeHTML(w.name)}</b></td><td>${escapeHTML(w.location||'Not recorded')}</td><td>${w.is_active?'Active':'Inactive'}</td><td>${w.inventory_records}</td><td>${w.low_stock_records}</td><td>${w.out_of_stock_records}</td><td>${w.shipment_count}</td><td>${w.active_disruptions}</td><td><button class="action-button" data-warehouse-open="${w.id}" type="button">View details</button></td></tr>`).join(''):`<tr><td colspan="10" class="empty-state">${d.total?'No warehouses match these filters.':'No warehouse records are available.'}</td></tr>`;$('#warehousePaginationLabel').textContent=`${d.total?((d.page-1)*d.limit+1):0}–${Math.min(d.page*d.limit,d.total)} of ${d.total} warehouses`;$('#warehousePrev').disabled=d.page<=1;$('#warehouseNext').disabled=d.page>=d.totalPages;};
  const loadWarehousePage=async()=>{try{const r=await api('/api/v1/inventory/overview');state.warehouses.summary=r.summary||{};renderInventoryKpis();initInventoryCharts();$('#inventoryUpdated').innerHTML=`<i></i> Updated ${new Date(r.last_updated).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'})} IST`;await loadWarehouseList();if(state.warehouses.selected)await loadWarehouseDetail(state.warehouses.selected,false);}catch(e){$('#inventoryKpis').innerHTML=`<article class="sub-kpi"><span>INVENTORY DATA</span><strong>Unavailable</strong><small>${escapeHTML(e.message)}</small></article>`;$('#warehouseTable').innerHTML=`<tr><td colspan="10" class="empty-state">${escapeHTML(e.message)}</td></tr>`;toast(e.message);}};
  const loadWarehouseCollection=async()=>{const d=state.warehouses,type=d.active;$('#warehouseDetailBody').innerHTML='<tr><td>Loading linked records…</td></tr>';const qs=new URLSearchParams({page:d.detailPage,limit:10,q:d.detailQ});if(type==='inventory'&&d.detailStatus)qs.set('status',d.detailStatus);const r=await api(`/api/v1/warehouses/${d.selected}/${type}?${qs}`);const rows=r.items||[];d.detailRows=rows;d.detailTotal=Number(r.total||rows.length);d.detailTotalPages=Number(r.total_pages||0);const cfg=warehouseTabs[type];$('#warehouseDetailHead').innerHTML=`<tr>${cfg.head.map(h=>`<th>${h}</th>`).join('')}</tr>`;$('#warehouseDetailBody').innerHTML=rows.length?rows.map(x=>`<tr>${cfg.keys.map(k=>{let v=x[k];if(k==='id'&&type==='shipments')return `<td><button class="shipment-open-link" data-warehouse-shipment="${x.id}" type="button">SHP-${x.id}</button></td>`;if(k==='id'&&type==='orders')return `<td><button class="shipment-open-link" data-order-open="${x.id}" type="button">ORD-${x.id}</button></td>`;if(k==='sku'&&type==='inventory')return `<td><button class="shipment-open-link" data-product-inventory="${escapeHTML(x.sku)}" type="button">${escapeHTML(v)}</button></td>`;if(k==='product_name'&&type==='inventory')return `<td><button class="shipment-open-link" data-inventory-record="${x.id}" type="button">${escapeHTML(v||'Not recorded')}</button></td>`;if(['timestamp','detected_at','updated_at','created_at','estimated_arrival','delivery_deadline','order_date'].includes(k))v=v?new Date(v).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'—';return `<td>${escapeHTML(v??'—')}</td>`;}).join('')}</tr>`).join(''):`<tr><td colspan="${cfg.head.length}" class="empty-state">No ${type} records are linked to this warehouse.</td></tr>`;$('#warehouseDetailPaginationLabel').textContent=`${d.detailTotal?((d.detailPage-1)*10+1):0}–${Math.min(d.detailPage*10,d.detailTotal)} of ${d.detailTotal} ${type}`;$('#warehouseDetailPrev').disabled=d.detailPage<=1;$('#warehouseDetailNext').disabled=d.detailPage>=d.detailTotalPages;$('#warehouseDetailStatus').classList.toggle('hidden',type!=='inventory');$('#warehouseRelationshipNote').textContent=type==='inventory'?'Available quantity = max(0, quantity − reserved quantity). Low Stock means available quantity is greater than zero and at or below the stored reorder point. This is a derived classification.':type==='shipments'?'Shipments are listed once when this warehouse is their origin or destination.':type==='disruptions'?'Only direct warehouse, verified shipment and inventory-source relationships are included. Unassigned disruptions are excluded.':'';};
  const loadWarehouseDetail=async(id,push=true)=>{const n=Number(id);if(!Number.isSafeInteger(n)||n<1)return;const d=state.warehouses;d.selected=n;d.detailPage=1;d.detailQ='';d.detailStatus='';$('#warehouseDetailSearch').value='';$('#warehouseDetailStatus').value='';if(push)history.pushState({page:'warehouses',warehouseId:n},'',`/app/warehouses/${n}`);$('#warehouseDetailPanel').classList.remove('hidden');$('#warehouseDetailTitle').textContent='Loading warehouse…';try{const r=await api(`/api/v1/warehouses/${n}`),w=r.warehouse,s=r.summary;$('#warehouseDetailTitle').textContent=`${w.name} · warehouse details`;$('#warehouseDetailMeta').textContent=`${w.code} · Warehouse record`;const profile=[['WAREHOUSE ID',w.id],['CODE',w.code],['LOCATION',w.location||'Not recorded'],['STATUS',w.is_active?'Active':'Inactive'],['CAPACITY (SQM)',w.capacity_sqm??'Not recorded'],['UTILIZATION',w.current_utilization??'Not recorded'],['CAPACITY UNITS',w.capacity_units??'Not recorded'],['RECORD TYPE','Warehouse']];$('#warehouseProfile').innerHTML=profile.map(([a,b])=>`<div class="supplier-profile-item"><span>${a}</span><b>${escapeHTML(b)}</b></div>`).join('');const cards=[['INVENTORY RECORDS',s.inventory_records],['AVAILABLE UNITS',s.available_units],['LOW STOCK',s.low_stock_records],['OUT OF STOCK',s.out_of_stock_records],['TOTAL SHIPMENTS',s.total_shipments],['DELIVERED',s.delivered_shipments],['DELAYED',s.delayed_shipments],['ACTIVE DISRUPTIONS',s.active_disruptions],['AFFECTED ORDERS',s.affected_orders],['RECOVERY PLANS',s.recovery_plans]];$('#warehouseDetailKpis').innerHTML=cards.map(([a,b])=>`<article class="sub-kpi"><span>${a}</span><strong>${hubCount(b)}</strong><small>Verified database relationship</small></article>`).join('');d.active='inventory';$$('[data-warehouse-tab]').forEach(x=>x.classList.toggle('active',x.dataset.warehouseTab==='inventory'));await loadWarehouseCollection();}catch(e){$('#warehouseDetailTitle').textContent='Warehouse unavailable';$('#warehouseDetailMeta').textContent=e.message;$('#warehouseDetailBody').innerHTML=`<tr><td class="empty-state">${escapeHTML(e.message)}</td></tr>`;toast(e.message);}};
  const updateWarehouseFilter=(key,value)=>{state.warehouses.filters[key]=value;state.warehouses.page=1;loadWarehouseList().catch(e=>toast(e.message));};

  const orderRiskLabel = (r) => r?.risk_classification || 'Not assessed';
  const loadOrderList = async () => {
    const d=state.orders,f=d.filters;const qs=new URLSearchParams({page:d.page,limit:d.limit,...Object.fromEntries(Object.entries(f).filter(([,v])=>v!==''))});
    $('#orderTable').innerHTML='<tr><td colspan="10">Loading customer orders…</td></tr>';
    const r=await api(`/api/v1/orders?${qs}`);d.rows=r.items||[];d.total=r.total||0;d.totalPages=r.total_pages||0;
    $('#orderTable').innerHTML=d.rows.length?d.rows.map(o=>`<tr><td class="mono">${escapeHTML(o.order_number)}</td><td>${escapeHTML(o.customer_name)}<small class="table-subline">${escapeHTML(o.customer_code||'Customer code unavailable')}</small></td><td>${o.order_date?new Date(o.order_date).toLocaleDateString('en-IN'):'—'}</td><td>${o.item_count}</td><td>${escapeHTML(o.warehouse_code||'Unassigned')}</td><td><span class="status-pill">${escapeHTML(o.status)}</span></td><td>${o.shipment_count?`<button class="hub-metric-link" type="button" data-order-open="${o.id}">${o.shipment_count} linked</button>`:'—'}</td><td><span class="risk-pill ${String(o.risk_classification||'').toLowerCase()}">${escapeHTML(orderRiskLabel(o))}</span></td><td>${o.disruption_count}</td><td><button class="action-button" type="button" data-order-open="${o.id}">View details ↗</button></td></tr>`).join(''):'<tr><td colspan="10" class="empty-state">No customer orders match these filters.</td></tr>';
    $('#orderPaginationLabel').textContent=`${d.total?((d.page-1)*d.limit+1):0}–${Math.min(d.page*d.limit,d.total)} of ${d.total} orders`;
    $('#orderPrev').disabled=d.page<=1;$('#orderNext').disabled=d.page>=d.totalPages;
    $('#orderUpdated').innerHTML='<i></i> Updated from SQLite';
  };
  const loadOrderPage = async () => {
    try{
      const [summary,warehouses]=await Promise.all([api('/api/v1/orders/overview'),api('/api/v1/warehouses?page=1&limit=100')]);state.orders.summary=summary;
      const kpis=[['TOTAL ORDERS',summary.total],['PENDING',summary.pending],['PROCESSING',summary.processing],['SHIPPED',summary.shipped],['DELIVERED',summary.delivered],['DELAYED',summary.delayed],['HIGH-RISK ORDERS',summary.high_risk],['DISRUPTION AFFECTED',summary.disruption_affected]];
      $('#orderKpis').innerHTML=kpis.map(([a,b])=>`<article class="sub-kpi"><span>${a}</span><strong>${hubCount(b)}</strong><small>Database-derived count</small></article>`).join('');
      const statusSelect=$('#orderStatusFilter'),oldStatus=statusSelect.value;statusSelect.innerHTML='<option value="">All statuses</option>'+summary.status_distribution.map(x=>`<option value="${escapeHTML(x.status)}">${escapeHTML(x.status)} (${x.count})</option>`).join('');statusSelect.value=oldStatus;
      const whSelect=$('#orderWarehouseFilter'),oldWh=whSelect.value;whSelect.innerHTML='<option value="">All assigned warehouses</option>'+(warehouses.warehouses||[]).map(w=>`<option value="${w.id}">${escapeHTML(w.code)} · ${escapeHTML(w.name)}</option>`).join('');whSelect.value=oldWh;
      for(const [id,rows,empty] of [['orderStatusChart',summary.status_distribution,'orderStatusEmpty'],['orderRiskChart',summary.risk_distribution,'orderRiskEmpty']]){if(state.charts[id])state.charts[id].destroy();const el=document.getElementById(id);const data=rows.filter(x=>x.count>0);document.getElementById(empty).classList.toggle('hidden',data.length>0);if(data.length&&window.Chart)state.charts[id]=new Chart(el,{type:'doughnut',data:{labels:data.map(x=>x.status||x.risk),datasets:[{data:data.map(x=>x.count),borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom'}}}});}
      await loadOrderList();const m=location.pathname.match(/^\/app\/orders\/(\d+)$/);if(m&&state.orders.selected!==Number(m[1]))await openOrderDetails(Number(m[1]),false);
    }catch(e){$('#orderUpdated').textContent='Order data unavailable';$('#orderTable').innerHTML=`<tr><td colspan="10" class="empty-state">${escapeHTML(e.message)}</td></tr>`;toast(e.message);}
  };
  const orderTabConfig={items:{head:['SKU','PRODUCT','QUANTITY','UNIT PRICE'],keys:['sku','item_name','quantity','unit_price']},shipments:{head:['SHIPMENT','TRACKING','CARRIER','ORIGIN','DESTINATION','STATUS','EXPECTED DELIVERY','ACTUAL DELIVERY'],keys:['id','tracking_number','carrier','origin_warehouse_code','destination_warehouse_code','status','estimated_arrival','actual_arrival']},disruptions:{head:['CODE','TYPE','SEVERITY','STATUS','DETECTED','DESCRIPTION','SHIPMENT'],keys:['disruption_code','disruption_type','severity','status','detected_at','description','tracking_number']},recovery:{head:['RECORD','PLAN','DESCRIPTION','STATUS','DISRUPTION / APPROVAL','DATE'],keys:['record_type','plan_code','title','status','disruption_info','created_at']},activities:{head:['TIME','ACTIVITY','DESCRIPTION','ENTITY','ACTOR'],keys:['timestamp','event_type','description','entity_type','actor_name']}};
  const loadOrderDetailCollection=async()=>{
    const d=state.orders,id=d.selected,type=d.active;$('#orderDetailBody').innerHTML='<tr><td>Loading linked records…</td></tr>';
    const r=await api(`/api/v1/orders/${id}/${type}`);let rows=[];
    if(type==='items')rows=r.items||[];else if(type==='shipments'||type==='disruptions'||type==='activities')rows=r.items||[];else if(type==='recovery')rows=[...(r.plans||[]).map(x=>({...x,record_type:'Plan',title:x.title,disruption_info:x.disruption_code||'—',created_at:x.created_at})),...(r.actions||[]).map(x=>({record_type:'Action',plan_code:x.plan_code,title:x.description,status:x.status,disruption_info:x.action_type,created_at:x.executed_at})),...(r.approvals||[]).map(x=>({record_type:'Approval',plan_code:x.plan_code,title:x.comments||`Requested by ${x.requester_name||'recorded actor'}`,status:x.status,disruption_info:x.approver_name||'No approver recorded',created_at:x.decision_at||x.requested_at}))];
    const cfg=orderTabConfig[type];$('#orderDetailHead').innerHTML=`<tr>${cfg.head.map(x=>`<th>${x}</th>`).join('')}</tr>`;
    $('#orderDetailBody').innerHTML=rows.length?rows.map(x=>`<tr>${cfg.keys.map(k=>{let v=x[k];if(k==='id'&&type==='shipments')return `<td><button class="action-button" type="button" data-order-shipment="${x.id}">SHP-${x.id}</button></td>`;if(['detected_at','estimated_arrival','actual_arrival','created_at','timestamp'].includes(k))v=v?new Date(v).toLocaleString('en-IN'):'—';if(k==='unit_price')v=v==null?'Not stored':`$${Number(v).toFixed(2)}`;return `<td>${escapeHTML(v??'—')}</td>`;}).join('')}</tr>`).join(''):'<tr><td colspan="8" class="empty-state">No verified '+type+' records are available for this order.</td></tr>';
    if(type==='shipments')$('#orderRelationshipNote').textContent=r.association_method||'Only verified disruption_affected_orders relationships are shown.';
    else if(type==='disruptions')$('#orderRelationshipNote').textContent='Disruptions are linked through the explicit disruption_affected_orders relationship.';
    else if(type==='recovery')$('#orderRelationshipNote').textContent='Recovery plans are linked by customer_order_id or through a disruption explicitly affecting this order. Actions and approvals are available in the order detail summary.';
    else if(type==='items')$('#orderRelationshipNote').textContent='Item quantities and unit prices are read directly from order_items.';
    else $('#orderRelationshipNote').textContent='Only existing audit records linked to this order and its verified disruptions or recovery plans are shown.';
  };
  const openOrderDetails=async(id,push=true)=>{
    const n=Number(id);if(!Number.isSafeInteger(n)||n<1)return;const d=state.orders;d.selected=n;d.active='items';if(push)history.pushState({page:'orders',orderId:n},'',`/app/orders/${n}`);if(state.currentPage!=='orders')setPage('orders',false);$('#orderDetailPanel').classList.remove('hidden');$('#orderDetailTitle').textContent='Loading order…';
    try{const r=await api(`/api/v1/orders/${n}`),o=r.order;d.detail=r;$('#orderDetailTitle').textContent=`${o.order_number} · order details`;$('#orderDetailMeta').textContent=`${o.status} · Customer order record`;
      const profile=[['ORDER ID',o.id],['ORDER NUMBER',o.order_number],['CUSTOMER',o.customer_name],['CUSTOMER CODE',o.customer_code||'Not linked'],['ORDER DATE',o.order_date],['STATUS',o.status],['PRIORITY',o.priority],['DELIVERY DEADLINE',o.delivery_deadline||'Not recorded'],['ASSIGNED WAREHOUSE',o.warehouse_code||'Unassigned'],['CUSTOMER CONTACT',o.customer_email||'Not recorded']];$('#orderProfile').innerHTML=profile.map(([a,b])=>`<div class="supplier-profile-item"><span>${a}</span><b>${escapeHTML(b??'Not recorded')}</b></div>`).join('');
      $('#orderDetailKpis').innerHTML=[['ORDER ITEMS',r.items.length],['LINKED SHIPMENTS',r.shipments.length],['LINKED DISRUPTIONS',r.disruptions.length],['RECOVERY PLANS',r.recovery.plans.length],['RECOVERY ACTIONS',r.recovery.actions.length],['APPROVAL RECORDS',r.recovery.approvals.length]].map(([a,b])=>`<article class="sub-kpi"><span>${a}</span><strong>${hubCount(b)}</strong><small>Verified records</small></article>`).join('');
      const risk=r.risk;$('#orderRiskSummary').innerHTML=risk.available?`<div><span class="section-kicker">EXISTING DETERMINISTIC RISK ENGINE</span><h3>${escapeHTML(risk.classification)} risk · ${risk.score}/100</h3><p>${escapeHTML(risk.explanation)}</p><small>Calculated ${escapeHTML(risk.calculated_at)} · ${escapeHTML(risk.engine_version||'')}</small><ul>${risk.factors.map(f=>`<li><b>${escapeHTML(f.factor.replaceAll('_',' '))}:</b> ${escapeHTML(f.evidence)}</li>`).join('')}</ul></div>`:`<div><span class="section-kicker">RISK ASSESSMENT</span><h3>Not assessed</h3><p>${escapeHTML(risk.explanation)}</p></div>`;
      $$('#page-orders [data-order-tab]').forEach(x=>x.classList.toggle('active',x.dataset.orderTab==='items'));await loadOrderDetailCollection();
    }catch(e){$('#orderDetailTitle').textContent='Order unavailable';$('#orderDetailMeta').textContent=e.message;$('#orderDetailBody').innerHTML=`<tr><td class="empty-state">${escapeHTML(e.message)}</td></tr>`;toast(e.message);}
  };

  const primaryTitle = {'overview':'Overview','network-operations':'Network Operations','disruption-intelligence':'Disruption Intelligence','recovery-management':'Recovery Management','intelligence-administration':'Intelligence & Administration'};
  const sectionNames = {
    overview:['overview-command','overview-network','overview-disruptions','overview-risk-recovery','overview-activity'],
    'network-operations':['network-summary','network-hubs','network-shipments','network-suppliers','network-warehouses','network-orders'],
    'disruption-intelligence':['disruption-command','disruption-monitoring','disruption-impact','disruption-priority','disruption-scenarios'],
    'recovery-management':['recovery-overview','recovery-ai','recovery-plans','recovery-execution'],
    'intelligence-administration':['admin-approvals','admin-audit','admin-data','admin-integrations','admin-notifications']
  };
  const workspaceDefaults = {'network-operations':'network-shipments','disruption-intelligence':'disruption-command','recovery-management':'recovery-overview','intelligence-administration':'admin-approvals'};
  const networkPanelPages = {'network-hubs':'hub-overview','network-shipments':'shipments','network-suppliers':'suppliers','network-warehouses':'warehouses','network-orders':'orders'};
  const activateWorkspacePanel = (primary,panelId) => {
    const root=document.getElementById(`primary-${primary}`);if(!root||!workspaceDefaults[primary])return;
    const selected=panelId||workspaceDefaults[primary];
    root.querySelectorAll(':scope > .scroll-section').forEach(panel=>{panel.hidden=panel.id!==selected;panel.classList.toggle('workspace-panel-active',panel.id===selected);});
    root.querySelectorAll('.page-view').forEach(view=>view.classList.toggle('active',view.closest('.scroll-section')?.id===selected));
    root.querySelectorAll('[data-workspace-target]').forEach(link=>{const on=link.dataset.workspaceTarget===selected;link.classList.toggle('active',on);link.setAttribute('aria-current',on?'page':'false');});
    root.classList.add('has-workspace-nav');
    // Chart.js measures canvases at creation time. Page-specific loaders run after
    // the active panel is selected; recovery execution is explicitly redrawn here.
    requestAnimationFrame(()=>{
      if(primary==='recovery-management')window.dispatchEvent(new CustomEvent('diq:recovery-panel-visible',{detail:{panel:selected}}));
    });
  };
  const activatePrimary = (primary) => {
    if(!primaryTitle[primary])primary='overview';
    state.primaryPage=primary;
    $$('.primary-page').forEach(el=>el.classList.toggle('active',el.dataset.primaryView===primary));
    $$('.nav-link[data-primary]').forEach(el=>el.classList.toggle('active',el.dataset.primary===primary));
    $('#sectionNavigator')?.classList.toggle('hidden',Boolean(workspaceDefaults[primary]));
    document.title=`${primaryTitle[primary]} · DisruptionIQ`;
    positionGlider();refreshSectionNavigator();
  };
  const loadGovernanceCenter=async()=>{
    const [approvalPayload,auditPayload]=await Promise.all([api('/api/v1/approvals'),api('/api/v1/audit-logs?limit=100')]);
    const rows=approvalPayload.approvals||[],pending=rows.filter(x=>x.status==='Pending'),history=rows.filter(x=>x.status!=='Pending');
    const approved=history.filter(x=>x.status==='Approved').length,closed=history.filter(x=>['Rejected','Changes Requested'].includes(x.status)).length;
    const metrics=$('#governanceKpis');if(metrics)metrics.innerHTML=[['PENDING REVIEW',pending.length,'Waiting for an independent decision'],['APPROVED',approved,'Approved operational submissions'],['REJECTED / CHANGES',closed,'Rejected or returned submissions'],['ACTIVE WORKFLOW ROLES',3,'Hub maker · Risk analyst · Recovery checker']].map(x=>`<article class="sub-kpi"><span>${x[0]}</span><strong>${x[1].toLocaleString('en-IN')}</strong><small>${x[2]}</small></article>`).join('');
    const queue=$('#governanceApprovalQueue');if(queue)queue.innerHTML=pending.map(a=>{const own=Number(a.requester_id)===Number(state.currentUser?.id);const canDecide=state.currentUser?.role==='RECOVERY_MANAGER'&&!own;const decisionControls=canDecide?`<div class="approval-actions"><button type="button" data-gov-decision="Changes Requested" data-gov-plan="${Number(a.recovery_plan_id)}">Request changes</button><button type="button" data-gov-decision="Rejected" data-gov-plan="${Number(a.recovery_plan_id)}">Reject</button><button class="approve-btn" type="button" data-gov-decision="Approved" data-gov-plan="${Number(a.recovery_plan_id)}">Approve ↗</button></div>`:`<div class="approval-restricted" role="note"><b>Decision locked for this account</b><span>${own?'You submitted this plan. Sign out and sign in as the Recovery Manager to make an independent decision.':'Only the Recovery Manager can decide on pending plans.'}</span></div>`;return `<article class="approval-item governance-approval-item"><div><h3>${escapeHTML(a.plan_code)} · ${escapeHTML(a.plan_title)}</h3><p>Submitted by ${escapeHTML(a.requester||'Internal user')} · ${escapeHTML(a.requested_at||'')} · ${a.cost_estimate_verified?`₹${Number(a.estimated_cost||0).toLocaleString('en-IN')} estimated`:'Cost not independently verified'}</p><div class="approval-impact">${own?'Submitted from your account — independent decision required.':'Recovery Manager decision required.'} · ${escapeHTML(a.plan_status||'Pending Approval')}</div></div>${decisionControls}</article>`;}).join('')||'<p class="empty-state">No plans are waiting for a decision. Draft templates must first be submitted from Recovery Planning.</p>';
    const historyHost=$('#governanceDecisionHistory');if(historyHost)historyHost.innerHTML=history.map(a=>`<tr><td class="route-cell">${escapeHTML(a.plan_code)} · ${escapeHTML(a.plan_title)}</td><td>${escapeHTML(a.requester||'—')}</td><td><span class="assessment ${a.status==='Approved'?'low':a.status==='Rejected'?'high':'medium'}">${escapeHTML(a.status)}</span></td><td>${escapeHTML(a.approver||'—')}</td><td class="mono">${escapeHTML(a.decision_at||'—')}</td><td>${escapeHTML(a.comments||'—')}</td></tr>`).join('')||'<tr><td colspan="6" class="empty-state">No completed decisions have been recorded yet.</td></tr>';
    const logRows=auditPayload.logs||[];const logHost=$('#auditTable');if(logHost)logHost.innerHTML=logRows.map(e=>`<tr><td class="mono">${escapeHTML(e.timestamp||'')}</td><td>${escapeHTML(e.full_name||e.username||'System')}</td><td class="route-cell">${escapeHTML(e.action||'')}</td><td>${escapeHTML(e.details||`${e.entity_type||''} ${e.entity_id||''}`)}</td><td><span class="assessment low">${escapeHTML(e.entity_type||'Event')}</span></td></tr>`).join('')||'<tr><td colspan="5" class="empty-state">No live user actions have been recorded yet. Login, plan creation, review, simulation and execution events will appear here.</td></tr>';
    const auditCount=$('#auditRecordCount');if(auditCount)auditCount.textContent=logRows.length.toLocaleString('en-IN');
  };
  $('#governanceRefresh')?.addEventListener('click',()=>loadGovernanceCenter().catch(e=>toast(e.message)));
  document.addEventListener('click',async event=>{
    const action=event.target.closest('[data-gov-decision]');if(!action)return;
    const choice=action.dataset.govDecision,plan=Number(action.dataset.govPlan);let comments='';
    if(choice!=='Approved'){comments=window.prompt(choice==='Rejected'?'Reason for rejection (required):':'Describe the required changes (required):')||'';if(!comments.trim()){toast('A comment is required for this decision.');return;}}
    else comments=window.prompt('Approval comment (optional):')||'';
    action.disabled=true;try{const result=await api(`/api/v1/recovery-plans/${plan}/decision`,{method:'POST',body:JSON.stringify({decision:choice,comments})});toast(result.message||`Plan ${choice.toLowerCase()}.`);await loadGovernanceCenter();state.data=await loadDashboardData();renderAll();}catch(error){toast(error.message);action.disabled=false;}
  });
  const renderNetworkOverview=()=>{const vals=[['WAREHOUSES',state.warehouses.summary?.total_warehouses,'Warehouse records'],['SHIPMENTS',state.shipments.summary?.total,'Tracked shipment records'],['SUPPLIERS',state.suppliers.summary?.total,'Supplier records'],['CUSTOMER ORDERS',state.orders.summary?.total,'Customer order records']];const host=$('#networkOverviewKpis');if(host)host.innerHTML=vals.map(([label,value,note])=>`<article class="sub-kpi"><span>${label}</span><strong>${value==null?'—':hubCount(value)}</strong><small>${value==null?'Unavailable':note}</small></article>`).join('');};
  const refreshPrimaryData = (primary) => {
    if(primary==='overview'){if(state.data)initOverviewCharts();}
    if(primary==='network-operations'){
      Promise.all([loadHubMonitoring(),loadShipmentPage(),loadSupplierPage(),loadWarehousePage(),loadOrderPage()]).then(renderNetworkOverview).catch(e=>toast(e.message));
      if(state.hubDetails.id)loadHubDetailsPage(state.hubDetails.id).catch(e=>toast(e.message));
    }
    if(primary==='recovery-management'){initRecoveryChart();}
    if(primary==='intelligence-administration'){loadGovernanceCenter().catch(e=>toast(e.message));loadNotifications().catch(e=>toast(e.message));}
  };
  const setPrimaryPage = (primary,push=true) => {
    if(!primaryTitle[primary])primary='overview';
    state.currentPage=primaryDefaults[primary]||'overview';
    activatePrimary(primary);
    if(workspaceDefaults[primary]){
      const root=document.getElementById(`primary-${primary}`);
      const hashTarget=decodeURIComponent(location.hash.replace(/^#/,''));
      const validHash=hashTarget&&root&&[...root.querySelectorAll('[data-workspace-target]')].some(link=>link.dataset.workspaceTarget===hashTarget);
      activateWorkspacePanel(primary,validHash?hashTarget:workspaceDefaults[primary]);
    }
    $$('.page-view').forEach(el=>el.classList.toggle('active',el.id===`page-${state.currentPage}`));
    if(push)history.pushState({primary},'',`/app/${primary}`);
    window.scrollTo({top:0,behavior:'smooth'});
    requestAnimationFrame(()=>refreshPrimaryData(primary));
  };
  const setPage = (page, push=true) => {
    if(primaryTitle[page])return setPrimaryPage(page,push);
    if(!pageNames[page])page='overview';
    const primary=modulePrimary[page]||'overview';
    state.currentPage=page;
    activatePrimary(primary);
    if(workspaceDefaults[primary])activateWorkspacePanel(primary,moduleSection[page]||workspaceDefaults[primary]);
    $$('.page-view').forEach(el=>el.classList.toggle('active',el.id===`page-${page}`));
    const targetId=moduleSection[page];const target=targetId?document.getElementById(targetId):null;
    if(target)target.scrollIntoView({behavior:'smooth',block:'start'});else window.scrollTo({top:0,behavior:'smooth'});
    if(push){
      const route=page==='hub-details'&&state.hubDetails.id?`/app/hub-details?id=${state.hubDetails.id}`:page==='shipments'&&state.shipments.detail?`/app/shipments?id=${state.shipments.detail}`:page==='suppliers'&&state.suppliers.selected?`/app/suppliers/${state.suppliers.selected}`:page==='warehouses'&&state.warehouses.selected?`/app/warehouses/${state.warehouses.selected}`:page==='orders'&&state.orders.selected?`/app/orders/${state.orders.selected}`:`/app/${page}`;
      history.pushState({page,primary},'',route);
    }
    requestAnimationFrame(()=>{
      if(page==='overview'){if(state.data)initOverviewCharts();}
      if(page==='hub-overview')loadHubMonitoring().catch(e=>toast(e.message));
      if(page==='hub-details')loadHubDetailsPage(state.hubDetails.id||undefined).catch(e=>toast(e.message));
      if(page==='shipments'){loadShipmentPage().catch(e=>toast(e.message));const shipmentId=Number(new URLSearchParams(location.search).get('id'));if(Number.isSafeInteger(shipmentId)&&shipmentId>0&&state.shipments.detail!==shipmentId)openShipmentDetails(shipmentId,false);}
      if(page==='suppliers'){const m=location.pathname.match(/^\/app\/suppliers\/(\d+)$/);if(m)state.suppliers.selected=Number(m[1]);loadSupplierPage().catch(e=>toast(e.message));}
      if(page==='warehouses'){const m=location.pathname.match(/^\/app\/warehouses\/(\d+)$/);if(m)state.warehouses.selected=Number(m[1]);loadWarehousePage().catch(e=>toast(e.message));}
      if(page==='orders')loadOrderPage().catch(e=>toast(e.message));
      if(page==='risk')initRiskChart();
      if(page==='recovery')initRecoveryChart();
    });
  };
  const pageFromPath=()=>{
    const path=location.pathname;
    if(['/app/overview','/app/network-operations','/app/disruption-intelligence','/app/recovery-management','/app/intelligence-administration'].includes(path))return path.split('/').pop();
    if(path.startsWith('/app/suppliers'))return 'suppliers';if(path.startsWith('/app/warehouses'))return 'warehouses';if(path.startsWith('/app/orders'))return 'orders';
    const last=path.split('/').filter(Boolean).pop();return pageNames[last]?last:'overview';
  };
  let sectionScrollFrame=0;
  const updateSectionIndicator=()=>{
    if(sectionScrollFrame)return;sectionScrollFrame=requestAnimationFrame(()=>{sectionScrollFrame=0;const ids=sectionNames[state.primaryPage]||[];const sections=ids.map(id=>document.getElementById(id)).filter(Boolean);if(!sections.length)return;const line=(document.querySelector('.topbar')?.getBoundingClientRect().bottom||0)+35;let active=sections[0];let best=Infinity;for(const sec of sections){const d=Math.abs(sec.getBoundingClientRect().top-line);if(sec.getBoundingClientRect().top<=line+80&&d<best){best=d;active=sec;}}const idx=sections.indexOf(active)+1;$('#sectionNavCurrent').textContent=String(idx).padStart(2,'0');$$('[data-section-link]').forEach(b=>{const on=b.dataset.sectionLink===active.id;b.classList.toggle('active',on);b.setAttribute('aria-current',on?'location':'false');});});
  };
  const refreshSectionNavigator=()=>{
    const host=$('#sectionNavLinks');if(!host)return;const ids=sectionNames[state.primaryPage]||[];host.innerHTML=ids.map((id,i)=>{const sec=document.getElementById(id),label=sec?.dataset.sectionTitle||`Section ${i+1}`;return `<button type="button" data-section-link="${id}" aria-label="Go to section ${i+1}: ${escapeHTML(label)}" title="${escapeHTML(label)}"><span>${String(i+1).padStart(2,'0')}</span></button>`;}).join('');$('#sectionNavTotal').textContent=String(ids.length).padStart(2,'0');updateSectionIndicator();};
  const loadNotifications=async()=>{
    const r=await api('/api/v1/notifications');const rows=r.notifications||[];const unread=rows.filter(x=>!x.is_read).length;
    const badge=$('#notificationBadge');badge.textContent=unread>9?'9+':String(unread);badge.classList.toggle('hidden',unread===0);
    const markup=rows.length?rows.map(n=>`<article class="notification-item ${n.is_read?'read':'unread'}"><div><b>${escapeHTML(n.title||n.notification_type||'Notification')}</b><p>${escapeHTML(n.message||n.body||'No message recorded')}</p><small>${escapeHTML(n.created_at||'Timestamp unavailable')}</small></div>${n.is_read?'':`<button type="button" data-notification-read="${n.id}">Mark read</button>`}</article>`).join(''):'<p class="empty-state">No notifications are available.</p>';
    $('#notificationPanelItems').innerHTML=markup;$('#notificationCenterList').innerHTML=markup;
  };
  window.addEventListener('diq:notifications-refresh',()=>loadNotifications().catch(e=>console.warn('Notification refresh failed:',e.message))); 
  window.setInterval(()=>{if(document.visibilityState==='visible')loadNotifications().catch(e=>console.warn('Notification poll failed:',e.message));},30000);
  const downloadCSV=(name, rows)=>{const csv=rows.map(row=>row.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);};

  document.addEventListener('keydown',event=>{
    if((event.key==='Enter'||event.key===' ')&&event.target.matches('[data-route][role="button"]')){event.preventDefault();setPage(event.target.dataset.route);}
  });
  document.addEventListener('click', async (event) => {
    const orderLink=event.target.closest('[data-order-open]');if(orderLink){event.preventDefault();openOrderDetails(orderLink.dataset.orderOpen);return;}
    const workspaceLink=event.target.closest('[data-workspace-target]');
    if(workspaceLink){
      event.preventDefault();
      const primary=workspaceLink.closest('.primary-page')?.dataset.primaryView;
      const targetId=workspaceLink.dataset.workspaceTarget;
      if(primary&&workspaceDefaults[primary]){
        activateWorkspacePanel(primary,targetId);
        const nextPage=networkPanelPages[targetId];
        if(nextPage){state.currentPage=nextPage;history.pushState({page:nextPage},'',`/app/${nextPage}`);}
        else history.pushState({primary,workspacePanel:targetId},'',`/app/${primary}#${targetId}`);
        window.scrollTo({top:0,behavior:'smooth'});
        if(targetId==='network-shipments')loadShipmentPage().catch(e=>toast(e.message));
        if(targetId==='network-hubs')loadHubMonitoring().catch(e=>toast(e.message));
        if(targetId==='network-suppliers')loadSupplierPage().catch(e=>toast(e.message));
        if(targetId==='network-warehouses')loadWarehousePage().catch(e=>toast(e.message));
        if(targetId==='network-orders')loadOrderPage().catch(e=>toast(e.message));
      }
      return;
    }
    const primaryNav=event.target.closest('[data-primary]');
    const sectionLink=event.target.closest('[data-section-link]');
    const sectionCard=event.target.closest('[data-section-target]');
    const route=event.target.closest('[data-route]');
    if(primaryNav){event.preventDefault();setPrimaryPage(primaryNav.dataset.primary);return;}
    if(sectionLink){event.preventDefault();document.getElementById(sectionLink.dataset.sectionLink)?.scrollIntoView({behavior:'smooth',block:'start'});return;}
    if(sectionCard){event.preventDefault();document.getElementById(sectionCard.dataset.sectionTarget)?.scrollIntoView({behavior:'smooth',block:'start'});return;}
    if(route){event.preventDefault();setPage(route.dataset.route);return;}
    const detail=event.target.closest('[data-disruption-detail]');
    if(detail){
      const panel=detail.closest('.priority-item')?.querySelector('.disruption-detail');
      if(!panel)return;
      if(!panel.classList.contains('hidden')){panel.classList.add('hidden');detail.textContent=detail.dataset.title||'View disruption details';return;}
      detail.disabled=true;
      try{
        const response=await api(`/api/v1/disruptions/${encodeURIComponent(detail.dataset.disruptionDetail)}`);
        const d=response.disruption||{};
        const detected=d.detected_at?new Date(d.detected_at).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kolkata'}):'—';
        panel.innerHTML=`<div><b>${escapeHTML(d.disruption_type||'Disruption')} · ${escapeHTML(d.severity||'Unknown')}</b><span>${escapeHTML(d.description||'No description recorded.')}</span><small>Detected ${escapeHTML(detected)} · ${Number(d.affected_orders||0)} affected orders · ${escapeHTML(d.tracking_number||'No linked shipment')} · ${escapeHTML(d.warehouse_name||'Hub not linked')}</small></div>`;
        panel.classList.remove('hidden');detail.dataset.title=detail.textContent;detail.textContent='Hide details';
      }catch(error){toast(error.message);}
      finally{detail.disabled=false;}
      return;
    }
    const ack=event.target.closest('[data-ack]');
    if(ack){ack.disabled=true;try{await api(`/api/incidents/${encodeURIComponent(ack.dataset.ack)}/acknowledge`,{method:'POST',body:'{}'});state.data=await loadDashboardData();renderAll();refreshCurrentChart();toast('Incident acknowledged and logged.');}catch(err){ack.disabled=false;toast(err.message);}return;}
    const decision=event.target.closest('[data-decision]');
    if(decision){const {approval,decision:choice}= {approval:decision.dataset.approval,decision:decision.dataset.decision};decision.disabled=true;try{await api(`/api/approvals/${encodeURIComponent(approval)}/decision`,{method:'POST',body:JSON.stringify({decision:choice})});state.data=await loadDashboardData();renderAll();refreshCurrentChart();toast(`Approval ${choice==='approve'?'approved':'declined'} and added to audit trail.`);}catch(err){decision.disabled=false;toast(err.message);}return;}
  });
  $('#hubSearch').addEventListener('input',()=>{state.hubs.filters.q=$('#hubSearch').value;state.hubs.page=1;loadHubList().catch(e=>toast(e.message));});
  $('#hubStatusFilter').addEventListener('change',()=>{state.hubs.filters.status=$('#hubStatusFilter').value;state.hubs.page=1;loadHubList().catch(e=>toast(e.message));});
  $('#hubHealthFilter').addEventListener('change',()=>{state.hubs.filters.health=$('#hubHealthFilter').value;state.hubs.page=1;loadHubList().catch(e=>toast(e.message));});
  $('#hubDisruptionFilter').addEventListener('change',()=>{state.hubs.filters.disruption=$('#hubDisruptionFilter').value;state.hubs.page=1;loadHubList().catch(e=>toast(e.message));});
  $('#hubPrevPage').addEventListener('click',()=>{if(state.hubs.page>1){state.hubs.page--;loadHubList().catch(e=>toast(e.message));}});
  $('#hubNextPage').addEventListener('click',()=>{if(state.hubs.page<state.hubs.totalPages){state.hubs.page++;loadHubList().catch(e=>toast(e.message));}});
  $('#refreshHubs').addEventListener('click',async()=>{const b=$('#refreshHubs');b.disabled=true;try{const ok=await loadHubMonitoring();if(ok){if(state.currentPage==='hub-details'&&state.hubDetails.id)await loadHubDetailsPage(state.hubDetails.id);toast('Hub monitoring refreshed from SQLite.');}}finally{b.disabled=false;}});
  $('#hubTable').addEventListener('click',event=>{const button=event.target.closest('[data-hub-open]');if(button)openHubDetails(Number(button.dataset.hubOpen));});
  $('#closeHubDetail').addEventListener('click',()=>$('#hubDetailPanel').classList.add('hidden'));
  $('#hubDetailsBack').addEventListener('click',()=>setPage('hub-overview'));
  $('#hubDetailsRefresh').addEventListener('click',()=>loadHubDetailsPage(state.hubDetails.id));
  $('#openWarehouseInventoryFromHub').addEventListener('click',()=>{const id=state.hubs.selected?.id;if(id){state.warehouses.selected=null;setPage('warehouses');loadWarehouseDetail(id);}});
  $('#openWarehouseInventoryFromHubDetails').addEventListener('click',()=>{const id=state.hubDetails.id;if(id){state.warehouses.selected=null;setPage('warehouses');loadWarehouseDetail(id);}});
  $('#page-hub-details').addEventListener('click',event=>{const tab=event.target.closest('[data-hub-tab]');if(tab){state.hubDetails.active=tab.dataset.hubTab;state.hubDetails.page=1;state.hubDetails.q='';state.hubDetails.status='';const opts=hubDetailStatuses[state.hubDetails.active]||[];$('#hubDetailsStatus').innerHTML='<option value="">All statuses</option>'+opts.map(x=>`<option value="${escapeHTML(x.toLowerCase())}">${escapeHTML(x)}</option>`).join('');loadHubDetailCollection().catch(e=>toast(e.message));}});
  $('#hubDetailsSearch').addEventListener('input',()=>{state.hubDetails.q=$('#hubDetailsSearch').value;state.hubDetails.page=1;loadHubDetailCollection().catch(e=>toast(e.message));});
  $('#hubDetailsStatus').addEventListener('change',()=>{state.hubDetails.status=$('#hubDetailsStatus').value;state.hubDetails.page=1;loadHubDetailCollection().catch(e=>toast(e.message));});
  $('#hubDetailsPrev').addEventListener('click',()=>{if(state.hubDetails.page>1){state.hubDetails.page--;loadHubDetailCollection().catch(e=>toast(e.message));}});
  $('#hubDetailsNext').addEventListener('click',()=>{if(state.hubDetails.page<state.hubDetails.totalPages){state.hubDetails.page++;loadHubDetailCollection().catch(e=>toast(e.message));}});
  const updateShipmentFilter=(key,value)=>{state.shipments.filters[key]=value;state.shipments.page=1;loadShipmentList().catch(e=>toast(e.message));};
  $('#shipmentSearch').addEventListener('input',()=>updateShipmentFilter('q',$('#shipmentSearch').value.trim()));
  $('#shipmentFilter').addEventListener('change',()=>updateShipmentFilter('status',$('#shipmentFilter').value));
  $('#shipmentCarrierFilter').addEventListener('change',()=>updateShipmentFilter('carrier',$('#shipmentCarrierFilter').value));
  $('#shipmentOriginFilter').addEventListener('change',()=>updateShipmentFilter('origin',$('#shipmentOriginFilter').value));
  $('#shipmentDestinationFilter').addEventListener('change',()=>updateShipmentFilter('destination',$('#shipmentDestinationFilter').value));
  $('#shipmentFromDate').addEventListener('change',()=>updateShipmentFilter('from',$('#shipmentFromDate').value));
  $('#shipmentToDate').addEventListener('change',()=>updateShipmentFilter('to',$('#shipmentToDate').value));
  $('#shipmentDisruptionFilter').addEventListener('change',()=>updateShipmentFilter('disruption',$('#shipmentDisruptionFilter').value));
  $('#shipmentSort').addEventListener('change',()=>{const [sort,direction]=$('#shipmentSort').value.split(':');state.shipments.filters.sort=sort;state.shipments.filters.direction=direction;loadShipmentList().catch(e=>toast(e.message));});
  $('#shipmentPrev').addEventListener('click',()=>{if(state.shipments.page>1){state.shipments.page--;loadShipmentList().catch(e=>toast(e.message));}});
  $('#shipmentNext').addEventListener('click',()=>{if(state.shipments.page<state.shipments.totalPages){state.shipments.page++;loadShipmentList().catch(e=>toast(e.message));}});
  $('#shipmentRefresh').addEventListener('click',()=>loadShipmentPage());
  $('#shipmentDetailRefresh').addEventListener('click',()=>openShipmentDetails(state.shipments.detail,false));
  $('#shipmentDetailClose').addEventListener('click',()=>{state.shipments.detail=null;$('#shipmentDetailPanel').classList.add('hidden');history.pushState({page:'shipments'},'','/app/shipments');});
  document.addEventListener('click',event=>{const btn=event.target.closest('[data-shipment-open]');if(btn){event.preventDefault();openShipmentDetails(btn.dataset.shipmentOpen);}});
  const updateSupplierFilter=(key,value)=>{state.suppliers.filters[key]=value;state.suppliers.page=1;loadSupplierList().catch(e=>toast(e.message));};
  $('#supplierSearch').addEventListener('input',()=>updateSupplierFilter('q',$('#supplierSearch').value.trim()));
  $('#supplierStatusFilter').addEventListener('change',()=>updateSupplierFilter('status',$('#supplierStatusFilter').value));
  $('#supplierProductFilter').addEventListener('change',()=>updateSupplierFilter('products',$('#supplierProductFilter').value));
  $('#supplierDisruptionFilter').addEventListener('change',()=>updateSupplierFilter('disruption',$('#supplierDisruptionFilter').value));
  $('#supplierActivityFilter').addEventListener('change',()=>updateSupplierFilter('activity',$('#supplierActivityFilter').value));
  $('#supplierSort').addEventListener('change',()=>{const [sort,direction]=$('#supplierSort').value.split(':');state.suppliers.filters.sort=sort;state.suppliers.filters.direction=direction;state.suppliers.page=1;loadSupplierList().catch(e=>toast(e.message));});
  $('#supplierPrev').addEventListener('click',()=>{if(state.suppliers.page>1){state.suppliers.page--;loadSupplierList().catch(e=>toast(e.message));}});
  $('#supplierNext').addEventListener('click',()=>{if(state.suppliers.page<state.suppliers.totalPages){state.suppliers.page++;loadSupplierList().catch(e=>toast(e.message));}});
  $('#supplierRefresh').addEventListener('click',()=>loadSupplierPage());
  $('#supplierDetailRefresh').addEventListener('click',()=>state.suppliers.selected&&loadSupplierDetail(state.suppliers.selected,false));
  $('#supplierDetailClose').addEventListener('click',()=>{state.suppliers.selected=null;$('#supplierDetailPanel').classList.add('hidden');history.pushState({page:'suppliers'},'','/app/suppliers');});
  $('#supplierDetailPrev').addEventListener('click',()=>{if(state.suppliers.detailPage>1){state.suppliers.detailPage--;loadSupplierDetailCollection().catch(e=>toast(e.message));}});
  $('#supplierDetailNext').addEventListener('click',()=>{if(state.suppliers.detailPage<state.suppliers.detailTotalPages){state.suppliers.detailPage++;loadSupplierDetailCollection().catch(e=>toast(e.message));}});
  $('#page-suppliers').addEventListener('click',event=>{const tab=event.target.closest('[data-supplier-tab]');if(tab){state.suppliers.active=tab.dataset.supplierTab;state.suppliers.detailPage=1;$$('[data-supplier-tab]').forEach(x=>x.classList.toggle('active',x===tab));loadSupplierDetailCollection().catch(e=>toast(e.message));}const open=event.target.closest('[data-supplier-open]');if(open)openSupplierDetails(open.dataset.supplierOpen);const ship=event.target.closest('[data-supplier-shipment]');if(ship){state.shipments.detail=null;setPage('shipments');openShipmentDetails(ship.dataset.supplierShipment);}});
  $('#supplierExport').addEventListener('click',()=>downloadCSV('disruptioniq-suppliers.csv',[['ID','Name','Code','City','State','Country','Products','Shipments','Disruptions','Status'],...state.suppliers.rows.map(x=>[x.id,x.name,x.code,x.city,x.state,x.country,x.product_count,x.shipment_count,x.disruption_count,x.is_active?'Active':'Inactive'])]));
  $('#warehouseSearch').addEventListener('input',()=>updateWarehouseFilter('q',$('#warehouseSearch').value.trim()));
  $('#warehouseStatusFilter').addEventListener('change',()=>updateWarehouseFilter('status',$('#warehouseStatusFilter').value));
  $('#warehouseLocationFilter').addEventListener('input',()=>updateWarehouseFilter('location',$('#warehouseLocationFilter').value.trim()));
  $('#warehouseDisruptionFilter').addEventListener('change',()=>updateWarehouseFilter('disruption',$('#warehouseDisruptionFilter').value));
  $('#warehouseSort').addEventListener('change',()=>{const [sort,direction]=$('#warehouseSort').value.split(':');state.warehouses.filters.sort=sort;state.warehouses.filters.direction=direction;state.warehouses.page=1;loadWarehouseList().catch(e=>toast(e.message));});
  $('#warehousePrev').addEventListener('click',()=>{if(state.warehouses.page>1){state.warehouses.page--;loadWarehouseList().catch(e=>toast(e.message));}});
  $('#warehouseNext').addEventListener('click',()=>{if(state.warehouses.page<state.warehouses.totalPages){state.warehouses.page++;loadWarehouseList().catch(e=>toast(e.message));}});
  $('#warehouseRefresh').addEventListener('click',()=>loadWarehousePage());
  $('#warehouseDetailRefresh').addEventListener('click',()=>state.warehouses.selected&&loadWarehouseDetail(state.warehouses.selected,false));
  $('#warehouseDetailClose').addEventListener('click',()=>{state.warehouses.selected=null;$('#warehouseDetailPanel').classList.add('hidden');history.pushState({page:'warehouses'},'','/app/warehouses');});
  $('#warehouseDetailPrev').addEventListener('click',()=>{if(state.warehouses.detailPage>1){state.warehouses.detailPage--;loadWarehouseCollection().catch(e=>toast(e.message));}});
  $('#warehouseDetailNext').addEventListener('click',()=>{if(state.warehouses.detailPage<state.warehouses.detailTotalPages){state.warehouses.detailPage++;loadWarehouseCollection().catch(e=>toast(e.message));}});
  $('#warehouseDetailSearch').addEventListener('input',()=>{state.warehouses.detailQ=$('#warehouseDetailSearch').value.trim();state.warehouses.detailPage=1;loadWarehouseCollection().catch(e=>toast(e.message));});
  $('#warehouseDetailStatus').addEventListener('change',()=>{state.warehouses.detailStatus=$('#warehouseDetailStatus').value;state.warehouses.detailPage=1;loadWarehouseCollection().catch(e=>toast(e.message));});
  $('#page-warehouses').addEventListener('click',async event=>{
    const tab=event.target.closest('[data-warehouse-tab]');if(tab){state.warehouses.active=tab.dataset.warehouseTab;state.warehouses.detailPage=1;state.warehouses.detailQ='';state.warehouses.detailStatus='';$('#warehouseDetailSearch').value='';$('#warehouseDetailStatus').value='';$$('[data-warehouse-tab]').forEach(x=>x.classList.toggle('active',x===tab));loadWarehouseCollection().catch(e=>toast(e.message));return;}
    const open=event.target.closest('[data-warehouse-open]');if(open){loadWarehouseDetail(open.dataset.warehouseOpen);return;}
    const ship=event.target.closest('[data-warehouse-shipment]');if(ship){state.shipments.detail=null;setPage('shipments');openShipmentDetails(ship.dataset.warehouseShipment);return;}
    const product=event.target.closest('[data-product-inventory]');if(product){try{const r=await api(`/api/v1/products/${encodeURIComponent(product.dataset.productInventory)}/inventory`);$('#productInventoryTitle').textContent=`Product ${product.dataset.productInventory} · warehouse stock`;$('#productInventoryRows').innerHTML=(r.items||[]).map(x=>`<div class="hub-detail-list-item"><b>${escapeHTML(x.warehouse_code)} · ${escapeHTML(x.warehouse_name)}</b><span>${hubCount(x.available_quantity)} available / ${hubCount(x.quantity)} total · ${escapeHTML(x.stock_status)}</span></div>`).join('')||'<p class="empty-state">No warehouse stock records are linked to this product.</p>';$('#productInventoryPanel').classList.remove('hidden');}catch(e){toast(e.message);}return;}
    const inv=event.target.closest('[data-inventory-record]');if(inv){try{const r=await api(`/api/v1/inventory/${inv.dataset.inventoryRecord}`),x=r.inventory;$('#inventoryRecordTitle').textContent=`${x.sku} · inventory record`;$('#inventoryRecordRows').innerHTML=[['Inventory ID',x.id],['Warehouse',`${x.warehouse_code} · ${x.warehouse_name}`],['Product',x.item_name],['SKU',x.sku],['Available quantity',x.available_quantity],['Reserved quantity',x.reserved_quantity],['Total quantity',x.quantity],['Reorder point',x.reorder_point],['Stock status',x.stock_status],['Last updated',x.updated_at]].map(([a,b])=>`<div class="supplier-profile-item"><span>${a}</span><b>${escapeHTML(b??'Not recorded')}</b></div>`).join('');$('#inventoryRecordPanel').classList.remove('hidden');}catch(e){toast(e.message);}return;}
  });
  $('#productInventoryClose').addEventListener('click',()=>$('#productInventoryPanel').classList.add('hidden'));
  $('#inventoryRecordClose').addEventListener('click',()=>$('#inventoryRecordPanel').classList.add('hidden'));
  $('#warehouseExport').addEventListener('click',()=>downloadCSV('disruptioniq-warehouses.csv',[['ID','Code','Name','Location','Status','Inventory Records','Low Stock','Out of Stock','Shipments','Active Disruptions'],...state.warehouses.rows.map(x=>[x.id,x.code,x.name,x.location,x.is_active?'Active':'Inactive',x.inventory_records,x.low_stock_records,x.out_of_stock_records,x.shipment_count,x.active_disruptions])]));


  const updateOrderFilter=(key,value)=>{state.orders.filters[key]=value;state.orders.page=1;loadOrderList().catch(e=>toast(e.message));};
  $('#orderSearch').addEventListener('input',()=>updateOrderFilter('q',$('#orderSearch').value.trim()));
  $('#orderStatusFilter').addEventListener('change',()=>updateOrderFilter('status',$('#orderStatusFilter').value));
  $('#orderRiskFilter').addEventListener('change',()=>updateOrderFilter('risk',$('#orderRiskFilter').value));
  $('#orderDisruptionFilter').addEventListener('change',()=>updateOrderFilter('disruption',$('#orderDisruptionFilter').value));
  $('#orderWarehouseFilter').addEventListener('change',()=>updateOrderFilter('warehouse',$('#orderWarehouseFilter').value));
  $('#orderFromDate').addEventListener('change',()=>updateOrderFilter('from',$('#orderFromDate').value));
  $('#orderToDate').addEventListener('change',()=>updateOrderFilter('to',$('#orderToDate').value));
  $('#orderSort').addEventListener('change',()=>{const [sort,direction]=$('#orderSort').value.split(':');state.orders.filters.sort=sort;state.orders.filters.direction=direction;state.orders.page=1;loadOrderList().catch(e=>toast(e.message));});
  $('#orderPrev').addEventListener('click',()=>{if(state.orders.page>1){state.orders.page--;loadOrderList().catch(e=>toast(e.message));}});
  $('#orderNext').addEventListener('click',()=>{if(state.orders.page<state.orders.totalPages){state.orders.page++;loadOrderList().catch(e=>toast(e.message));}});
  $('#orderRefresh').addEventListener('click',()=>loadOrderPage());
  $('#orderExport').addEventListener('click',()=>downloadCSV('disruptioniq-customer-orders.csv',[['Order','Customer','Customer code','Order date','Items','Warehouse','Status','Shipments','Risk','Disruptions'],...state.orders.rows.map(o=>[o.order_number,o.customer_name,o.customer_code,o.order_date,o.item_count,o.warehouse_code,o.status,o.shipment_count,o.risk_classification,o.disruption_count])]));
  $('#orderDetailRefresh').addEventListener('click',()=>state.orders.selected&&openOrderDetails(state.orders.selected,false));
  $('#orderDetailClose').addEventListener('click',()=>{state.orders.selected=null;$('#orderDetailPanel').classList.add('hidden');history.pushState({page:'orders'},'','/app/orders');});
  $('#page-orders').addEventListener('click',async event=>{const tab=event.target.closest('[data-order-tab]');if(tab){state.orders.active=tab.dataset.orderTab;$$('#page-orders [data-order-tab]').forEach(x=>x.classList.toggle('active',x===tab));loadOrderDetailCollection().catch(e=>toast(e.message));return;}const ship=event.target.closest('[data-order-shipment]');if(ship){state.orders.selected=null;$('#orderDetailPanel').classList.add('hidden');setPage('shipments');openShipmentDetails(ship.dataset.orderShipment);}});
  $('#themeToggle').addEventListener('click',()=>{const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;localStorage.setItem('diq-theme',next);$('#themeToggle .theme-icon').textContent=next==='dark'?'☼':'◐';renderAll();refreshCurrentChart();});
  const savedTheme=localStorage.getItem('diq-theme');if(savedTheme){document.documentElement.dataset.theme=savedTheme;$('#themeToggle .theme-icon').textContent=savedTheme==='dark'?'☼':'◐';}
  $('#refreshData').addEventListener('click',async()=>{const button=$('#refreshData');button.disabled=true;try{state.data=await loadDashboardData();renderAll();refreshCurrentChart();toast('Dashboard data refreshed from SQLite.');}catch(e){showDashboardError(e);}finally{button.disabled=false;}});
  $('#trendRange').addEventListener('change',async()=>{
    try{state.data=await loadDashboardData(Number($('#trendRange').value));renderOverview();refreshCurrentChart();toast(`Disruption trend refreshed for ${$('#trendRange').value} days.`);}
    catch(error){showDashboardError(error);}
  });
  $('#exportShipments').addEventListener('click',()=>downloadCSV('disruptioniq-shipments.csv',[['ID','Tracking','Carrier','Origin','Destination','Status','Expected delivery','Disruptions'],...state.shipments.rows.map(s=>[s.id,s.tracking_number,s.carrier_name,s.origin_warehouse_code||s.origin_city,s.destination_warehouse_code||s.destination_city,s.status,s.estimated_arrival,s.disruption_count])]));
  $('#exportAudit').addEventListener('click',()=>downloadCSV('disruptioniq-audit.csv',[['Time','Actor','Action','Target','Type'],...state.data.auditTrail.map(e=>[e.time,e.actor,e.action,e.target,e.kind])]));
  $('#userMenu').addEventListener('click',()=>$('#userMenuPanel').classList.toggle('hidden'));
  $('#notificationButton').addEventListener('click',async()=>{const panel=$('#notificationPanel');panel.classList.toggle('hidden');$('#notificationButton').setAttribute('aria-expanded',String(!panel.classList.contains('hidden')));if(!panel.classList.contains('hidden'))try{await loadNotifications();}catch(e){$('#notificationPanelItems').innerHTML=`<p class="empty-state">${escapeHTML(e.message)}</p>`;}});
  $('#notificationClose').addEventListener('click',()=>{$('#notificationPanel').classList.add('hidden');$('#notificationButton').setAttribute('aria-expanded','false');});
  $('#notificationRefresh').addEventListener('click',()=>loadNotifications().catch(e=>toast(e.message)));
  document.addEventListener('click',async event=>{const read=event.target.closest('[data-notification-read]');if(!read)return;try{await api(`/api/v1/notifications/${Number(read.dataset.notificationRead)}/read`,{method:'POST',body:'{}'});await loadNotifications();}catch(e){toast(e.message);}});
  $('#logoutButton').addEventListener('click',async()=>{try{await api('/api/auth/logout',{method:'POST',body:'{}'});}catch{}window.location.assign('/login');});
  window.addEventListener('popstate',()=>{const page=pageFromPath(),id=Number(new URLSearchParams(location.search).get('id'));if(page==='hub-details'&&Number.isSafeInteger(id)&&id>0)state.hubDetails.id=id;if(page==='shipments')state.shipments.detail=Number.isSafeInteger(id)&&id>0?id:null;if(page==='suppliers'){const m=location.pathname.match(/^\/app\/suppliers\/(\d+)$/);state.suppliers.selected=m?Number(m[1]):null;$('#supplierDetailPanel').classList.toggle('hidden',!state.suppliers.selected);}if(page==='warehouses'){const m=location.pathname.match(/^\/app\/warehouses\/(\d+)$/);state.warehouses.selected=m?Number(m[1]):null;$('#warehouseDetailPanel').classList.toggle('hidden',!state.warehouses.selected);}let orderId=null;if(page==='orders'){const m=location.pathname.match(/^\/app\/orders\/(\d+)$/);orderId=m?Number(m[1]):null;state.orders.selected=null;$('#orderDetailPanel').classList.add('hidden');}setPage(page,false);if(orderId)openOrderDetails(orderId,false);});
  window.addEventListener('resize',()=>{positionGlider();updateSectionIndicator();});
  window.addEventListener('scroll',updateSectionIndicator,{passive:true});
  document.addEventListener('keydown',event=>{if(!event.altKey||!['ArrowDown','ArrowUp'].includes(event.key))return;const ids=sectionNames[state.primaryPage]||[];const current=$('[data-section-link].active')?.dataset.sectionLink;let i=Math.max(0,ids.indexOf(current));i=Math.max(0,Math.min(ids.length-1,i+(event.key==='ArrowDown'?1:-1)));document.getElementById(ids[i])?.scrollIntoView({behavior:'smooth',block:'start'});event.preventDefault();});
  if (document.fonts?.ready) document.fonts.ready.then(positionGlider);
  if(window.matchMedia('(pointer:fine)').matches){const dot=$('#cursorDot'),ring=$('#cursorRing');let mx=0,my=0,rx=0,ry=0;window.addEventListener('mousemove',e=>{mx=e.clientX;my=e.clientY;dot.style.opacity=ring.style.opacity='1';dot.style.left=`${mx}px`;dot.style.top=`${my}px`;});const move=()=>{rx+=(mx-rx)*.22;ry+=(my-ry)*.22;ring.style.left=`${rx}px`;ring.style.top=`${ry}px`;requestAnimationFrame(move);};move();document.addEventListener('mouseover',e=>{if(e.target.closest('a,button,select,input'))ring.classList.add('hover');else ring.classList.remove('hover');});}

  (async()=>{
    try{const me=await api('/api/me');state.currentUser=me.user;$('.user-name').textContent=me.user.name;$('.user-avatar').textContent=me.user.initials;const menuName=$('.user-menu-name'),menuRole=$('.user-menu-role');if(menuName)menuName.textContent=me.user.name;if(menuRole)menuRole.textContent=({HUB_INCHARGE:'Hub In-Charge',RISK_ANALYST:'Risk Analyst',RECOVERY_MANAGER:'Recovery Manager',CUSTOMER:'Customer'})[me.user.role]||me.user.role;const roleNav={HUB_INCHARGE:['overview','network-operations','disruption-intelligence','recovery-management','intelligence-administration'],RISK_ANALYST:['overview','network-operations','disruption-intelligence'],RECOVERY_MANAGER:['overview','network-operations','disruption-intelligence','recovery-management','intelligence-administration'],CUSTOMER:[]};const allowed=new Set(roleNav[me.user.role]||[]);$$('.nav-link[data-primary]').forEach(link=>{link.hidden=!allowed.has(link.dataset.primary);});const isMaker=me.user.role==='HUB_INCHARGE',isChecker=me.user.role==='RECOVERY_MANAGER',isRisk=me.user.role==='RISK_ANALYST';['#newRecoveryPlan','#rwPlanEditor','#rwCreatePlan'].forEach(sel=>{const el=$(sel);if(el)el.hidden=!isMaker;});const adminLink=$('.nav-link[data-primary="intelligence-administration"]');if(adminLink)adminLink.hidden=!(isMaker||isChecker);const recoveryLink=$('.nav-link[data-primary="recovery-management"]');if(recoveryLink)recoveryLink.hidden=isRisk;document.documentElement.dataset.userRole=me.user.role;const directHubId=Number(new URLSearchParams(location.search).get('id'));if(pageFromPath()==='hub-details'&&Number.isSafeInteger(directHubId)&&directHubId>0)state.hubDetails.id=directHubId;if(pageFromPath()==='suppliers'){const m=location.pathname.match(/^\/app\/suppliers\/(\d+)$/);state.suppliers.selected=m?Number(m[1]):null;}if(pageFromPath()==='warehouses'){const m=location.pathname.match(/^\/app\/warehouses\/(\d+)$/);state.warehouses.selected=m?Number(m[1]):null;}}
    catch{window.location.assign('/login');return;}
    try{state.data=await loadDashboardData();renderAll();setPage(pageFromPath(),false);loadNotifications().catch(e=>console.warn('Notification feed unavailable:',e.message));requestAnimationFrame(()=>{positionGlider();refreshSectionNavigator();});}
    catch(error){showDashboardError(error);}
  })();
})();
