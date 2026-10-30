'use strict';
const crypto=require('node:crypto');
const {db,get,all,run,nowIso,audit}=require('../database');
const {analyzeDisruptionImpact}=require('./impact-engine');
const PERMITTED={Draft:['Pending Approval','Cancelled'],'Changes Requested':['Pending Approval','Cancelled'],'Pending Approval':['Approved','Rejected','Changes Requested','Cancelled'],Approved:['Execution Ready','Draft','Cancelled'],'Execution Ready':['Executed','Execution Failed','Cancelled'],Rejected:['Draft'],Executed:[],Cancelled:[],'Execution Failed':['Execution Ready','Cancelled']};
const role=u=>!!u&&u.role==='HUB_INCHARGE';
const approverRole=u=>!!u&&u.role==='RECOVERY_MANAGER';
const executorRole=u=>!!u&&u.role==='RECOVERY_MANAGER';
const num=(x)=>Number(x||0);const clamp=(x,a=0,b=100)=>Math.min(b,Math.max(a,x));const rnd=x=>Math.round((x+Number.EPSILON)*100)/100;
function generateRecoveryRecommendations(disruptionId){
 const dis=get(`SELECT d.*,s.tracking_number,s.carrier,s.origin_city,s.destination_city,s.supplier_id,s.destination_warehouse_id FROM disruptions d LEFT JOIN shipments s ON s.id=d.shipment_id WHERE d.id=?`,Number(disruptionId));if(!dis)return[];
 const impact=analyzeDisruptionImpact(disruptionId);const skus=impact.affected_skus||[];const sku=skus[0]||'SKU-UNKNOWN';const destId=dis.warehouse_id||dis.destination_warehouse_id;const dest=destId?get('SELECT * FROM warehouses WHERE id=?',destId):null;const destCode=dest?.code||'DEST-HUB';
 const metrics=impact.shortage_metrics?.[sku]||{};const totalDemand=Math.max(0,num(metrics.total_demand));const available=Math.max(0,num(metrics.available_inventory));const confirmed=Math.max(0,num(metrics.confirmed_shortage));const potential=Math.max(0,num(metrics.potential_shortage));const deficit=confirmed>0?confirmed:potential>0?potential:totalDemand>available?totalDemand-available:0;
 const candidates=[];const delay=Math.max(0,num(dis.estimated_delay_hours));
 // Even without a verified stock deficit, explicitly linked customer orders support
 // an advisory prioritisation plan. It does not promise stock, freight or delivery.
 const linkedOrders=impact.orders_affected||[];
 if(linkedOrders.length){
  const qty=linkedOrders.length;
  candidates.push({option_id:`OPT-ORDER-PRIORITY-${dis.id}`,option_type:'Order Reprioritisation',strategy_type:'Order Reprioritisation',title:`Reprioritise ${qty} affected customer order${qty===1?'':'s'}`,sku:null,quantity:qty,deficit_qty:null,remaining_shortage:null,coverage_pct:null,is_full_recovery:false,recovery_type:'Service prioritisation advisory',source_warehouse_id:null,destination_warehouse_id:null,source_location:null,destination_location:null,estimated_cost:null,estimated_delay_reduction_hours:null,estimated_duration_hours:null,expected_risk_reduction_pts:null,feasibility:'Advisory',confidence_score:null,inventory_impact:null,rationale:`${qty} customer order${qty===1?' is':'s are'} explicitly linked to ${dis.disruption_code}. Review the stored priority and delivery deadline, then sequence service attention and customer communications. This does not change order status or guarantee fulfilment.`,assumptions:'Verified: linked order IDs, stored priority, current status and delivery deadlines. Not verified: available labour, fulfilment capacity, dispatch capacity or revised delivery estimates.',proposed_actions:[{sequence:1,action_type:'ORDER_REPRIORITISATION',description:`Review and rank the ${qty} linked orders using stored priority and delivery deadlines; do not alter fulfilment status.`,cost:0,role:'HUB_INCHARGE'},{sequence:2,action_type:'CUSTOMER_COMMUNICATION_REVIEW',description:'Prepare customer updates only after the revised service sequence is confirmed by the responsible team.',cost:0,role:'HUB_INCHARGE'}]});
 }
 if(destId&&deficit>0){
  const alts=all(`SELECT i.*,w.code AS warehouse_code,w.location AS warehouse_location FROM inventories i JOIN warehouses w ON w.id=i.warehouse_id WHERE i.warehouse_id<>? AND i.sku=?`,destId,sku);
  for(const inv of alts){const avail=Math.max(0,inv.quantity-inv.reserved_quantity);const surplus=Math.max(0,avail-inv.reorder_point);if(surplus<=0)continue;const qty=Math.min(deficit,surplus),duration=null,cost=null,remaining=Math.max(0,deficit-qty),coverage=deficit>0?Math.min(100,rnd(qty/deficit*100)):100,full=remaining===0,delaySaved=null,rr=null;
   candidates.push({option_id:`OPT-XFER-${inv.warehouse_code}`,option_type:'Inter-Warehouse Stock Transfer',strategy_type:'Inter-Warehouse Stock Transfer',title:`Inter-Warehouse Stock Transfer from ${inv.warehouse_code} to ${destCode}`,sku,quantity:qty,deficit_qty:deficit,remaining_shortage:remaining,coverage_pct:coverage,is_full_recovery:full,recovery_type:full?'Full Recovery':'Partial Mitigation',source_warehouse_id:inv.warehouse_id,destination_warehouse_id:destId,source_location:`${inv.warehouse_code} (${inv.warehouse_location})`,destination_location:`${destCode} (${dest.location})`,estimated_cost:null,estimated_delay_reduction_hours:null,estimated_duration_hours:null,expected_risk_reduction_pts:null,feasibility:'Constrained',confidence_score:null,inventory_impact:{source_current_available:avail,source_projected_available:Math.max(0,avail-qty),destination_current_available:available,destination_projected_available:available+qty,reorder_point_protected:avail-qty>=inv.reorder_point,deficit_qty:deficit,remaining_shortage:remaining,coverage_pct:coverage,is_full_recovery:full,recovery_type:full?'Full Recovery':'Partial Mitigation'},rationale:`Inventory records show ${qty} units of ${sku} above the source warehouse reorder threshold at ${inv.warehouse_code}. This covers ${coverage}% of the calculated shortage. Transfer logistics, cost and arrival time are not verified.`,assumptions:'Verified: source on-hand, reserved quantity and reorder point. Not available: transport corridor, vehicle capacity, transfer cost and ETA. Human operational confirmation is required.',proposed_actions:[{sequence:1,action_type:'RESERVE_TRANSFER_STOCK',description:`Propose holding ${qty} units at ${inv.warehouse_code} staging bay`,cost:0,role:'HUB_INCHARGE'},{sequence:2,action_type:'DISPATCH_INTERHUB_FREIGHT',description:`Obtain human confirmation for transfer logistics ${inv.warehouse_code} -> ${destCode}`,cost:0,role:'HUB_INCHARGE'},{sequence:3,action_type:'RECEIVE_AND_ALLOCATE',description:`Record inbound receipt at ${destCode} and allocate to affected orders after physical confirmation`,cost:0,role:'HUB_INCHARGE'}]});
  }
 }
 // Supplier-SKU capability, open capacity, transport capacity, route feasibility, cost and ETA are not represented in this dataset.
 // Do not fabricate supplier or air-charter options.
 for(const o of candidates)o.recommendation_score=null;
 candidates.sort((a,b)=>Number(b.coverage_pct||0)-Number(a.coverage_pct||0)||Number(b.is_full_recovery)-Number(a.is_full_recovery)||a.option_id.localeCompare(b.option_id));
 return candidates.map((x,i)=>({...x,rank:i+1,badge:i===0?'Primary Recommendation':i===1?'Alternative Option':'Fallback Strategy'}));
}
function createPlanFromRecommendation(disruptionId,option,user){
 const d=get('SELECT * FROM disruptions WHERE id=?',Number(disruptionId));if(!d)throw new Error('Disruption not found.');
 if(!role(user))throw new Error('Only Hub In-Charge can create recovery plans.');
 if(!option||!option.option_id||!option.strategy_type)throw new Error('A valid generated recommendation is required.');
 const code=`REC-${d.disruption_code.slice(-7)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;const now=nowIso();
 try{db.exec('BEGIN IMMEDIATE');
  if(!get('SELECT id FROM disruptions WHERE id=?',d.id))throw new Error('Linked disruption no longer exists.');
  const existing=get(`SELECT * FROM recovery_plans WHERE disruption_id=? AND strategy_type=? AND status IN ('Draft','Pending Approval')`,d.id,option.strategy_type);if(existing){db.exec('COMMIT');return existing;}
  const r=run(`INSERT INTO recovery_plans(plan_code,disruption_id,title,strategy_type,status,sku,quantity,source_warehouse_id,destination_warehouse_id,source_location,destination_location,estimated_cost,cost_estimate_verified,estimated_delay_reduction_hours,description,rationale,version,created_by_id,created_at,updated_at,data_origin) VALUES(?,?,?,?,'Draft',?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,'operational')`,code,d.id,option.title,option.strategy_type,option.sku,Number(option.quantity||0),option.source_warehouse_id,option.destination_warehouse_id,option.source_location,option.destination_location,Number(option.estimated_cost||0),option.estimated_cost==null?0:1,Number(option.estimated_delay_reduction_hours||0),option.rationale||'',option.assumptions||'',user.id,now,now);
  const planId=Number(r.lastInsertRowid);for(const a of option.proposed_actions||[])run(`INSERT INTO recovery_actions(recovery_plan_id,action_sequence,action_type,description,status,cost,assigned_to_role,data_origin) VALUES(?,?,?,?,'Pending',?,?,'operational')`,planId,a.sequence||1,a.action_type||'GENERAL_ACTION',a.description||'Operational mitigation action',Number(a.cost||0),a.role||'HUB_INCHARGE');
  audit({userId:user.id,action:'CREATE_RECOVERY_PLAN',entityType:'RecoveryPlan',entityId:planId,details:`Draft plan ${code} created for ${d.disruption_code} (${option.strategy_type}).`});
  run(`INSERT INTO notifications(recipient_role,title,message,category,is_read,created_at) VALUES(?,?,?,?,0,?)`,'HUB_INCHARGE',`New Recovery Plan Draft: ${code}`,`Plan '${option.title}' has been generated and is ready for review.`,'Info',now);
  db.exec('COMMIT');return get('SELECT * FROM recovery_plans WHERE id=?',planId);
 }catch(e){try{db.exec('ROLLBACK')}catch{}throw e;}
}
function submitPlanForApproval(planId,user){
 if(!role(user))return{ok:false,message:'Only Hub In-Charge can submit recovery plans.'};
 try{db.exec('BEGIN IMMEDIATE');const plan=get('SELECT * FROM recovery_plans WHERE id=?',Number(planId));if(!plan)throw new Error('Plan not found.');if(!['operational','synthetic_demo'].includes(plan.data_origin))throw new Error('This record cannot enter the approval workflow.');if(!['Draft','Changes Requested'].includes(plan.status))throw new Error(`Cannot submit plan in '${plan.status}' status for approval.`);if(!(plan.quantity>0))throw new Error('Plan must specify a valid positive quantity.');
  if(plan.created_by_id&&Number(plan.created_by_id)!==Number(user.id))throw new Error('Only the plan owner can submit this draft.');
  const required='RECOVERY_MANAGER',now=nowIso();run("UPDATE recovery_plans SET status='Pending Approval',created_by_id=COALESCE(created_by_id,?),data_origin='operational',updated_at=? WHERE id=? AND status IN ('Draft','Changes Requested')",user.id,now,plan.id);run("UPDATE recovery_actions SET data_origin='operational' WHERE recovery_plan_id=? AND data_origin='synthetic_demo'",plan.id);
  const approval=get("SELECT * FROM approvals WHERE recovery_plan_id=? AND status='Pending' AND data_origin='operational'",plan.id);if(approval)run("UPDATE approvals SET requester_id=?,required_role=?,requested_at=?,comments=NULL,approver_id=NULL,decision_at=NULL,data_origin='operational' WHERE id=?",user.id,required,now,approval.id);else run(`INSERT INTO approvals(recovery_plan_id,requester_id,required_role,status,requested_at,data_origin) VALUES(?,?,?,'Pending',?,'operational')`,plan.id,user.id,required,now);
  audit({userId:user.id,action:'SUBMIT_FOR_APPROVAL',entityType:'RecoveryPlan',entityId:plan.id,details:`Plan ${plan.plan_code} submitted for approval by ${user.username} (Required Role: ${required}).`});run(`INSERT INTO notifications(recipient_role,title,message,category,is_read,created_at) VALUES(?,?,?,?,0,?)`,required,`Plan Awaiting Approval: ${plan.plan_code}`,`Plan '${plan.title}' requires independent approval review.`,'Alert',now);db.exec('COMMIT');return{ok:true,message:`Plan ${plan.plan_code} successfully submitted for approval.`};
 }catch(e){try{db.exec('ROLLBACK')}catch{}return{ok:false,message:e.message};}
}
function reviewPlanApproval(planId,user,decision,comments=''){
 if(!approverRole(user))return{ok:false,message:`Access denied: Role '${user?.role||'unknown'}' is not authorized to decide on this plan. Recovery Manager permission is required.`};
 try{db.exec('BEGIN IMMEDIATE');const plan=get('SELECT * FROM recovery_plans WHERE id=?',Number(planId));if(!plan)throw new Error('Plan not found.');if(plan.status!=='Pending Approval')throw new Error(`Plan is in '${plan.status}' status, not pending approval.`);if(plan.data_origin!=='operational')throw new Error('Reference templates cannot be approved.');if(Number(plan.created_by_id)===Number(user.id))throw new Error('Separation of duties violation: You cannot approve your own recovery plan.');
  const approval=get("SELECT * FROM approvals WHERE recovery_plan_id=? AND status='Pending' AND data_origin='operational' ORDER BY requested_at DESC LIMIT 1",plan.id);if(!approval)throw new Error('No pending approval record exists for this plan.');if(approval.required_role!=='RECOVERY_MANAGER')throw new Error('This approval is not assigned to the Recovery Manager role.');if(Number(approval.requester_id)===Number(user.id))throw new Error('Separation of duties violation: The requester cannot approve their own recovery plan.');
  if(['Rejected','Changes Requested'].includes(decision)&&!String(comments||'').trim())throw new Error(`A clear reason is mandatory when ${decision.toLowerCase()} a plan.`);if(!['Approved','Rejected','Changes Requested'].includes(decision))throw new Error('Invalid approval decision.');
  const now=nowIso(),status=decision==='Approved'?'Approved':decision;const changed=run(`UPDATE approvals SET status=?,approver_id=?,decision_at=?,comments=? WHERE id=? AND status='Pending'`,decision,user.id,now,String(comments||''),approval.id);if(Number(changed.changes)!==1)throw new Error('Approval has already been decided. Refresh the approval centre.');
  if(decision==='Approved')run(`UPDATE recovery_plans SET status='Approved',approval_version=version,updated_at=? WHERE id=? AND status='Pending Approval'`,now,plan.id);else run("UPDATE recovery_plans SET status=?,updated_at=? WHERE id=? AND status='Pending Approval'",status,now,plan.id);
  audit({userId:user.id,action:decision==='Approved'?'APPROVE_PLAN':decision==='Rejected'?'REJECT_PLAN':'REQUEST_PLAN_CHANGES',entityType:'RecoveryPlan',entityId:plan.id,details:`${decision} plan ${plan.plan_code}. ${comments||''}`});
  if(plan.created_by_id)run(`INSERT INTO notifications(recipient_role,recipient_user_id,title,message,category,is_read,created_at,data_origin) VALUES('HUB_INCHARGE',?,?,?,?,0,?,'operational')`,plan.created_by_id,`Recovery plan ${decision.toLowerCase()}: ${plan.plan_code}`,`Recovery Manager ${user.full_name||user.username} recorded '${decision}' for ${plan.title}.${comments?` Comment: ${comments}`:''}`,decision==='Approved'?'Info':'Alert',now);
  db.exec('COMMIT');return{ok:true,message:`Plan ${plan.plan_code}: ${decision}.`};
 }catch(e){try{db.exec('ROLLBACK')}catch{}return{ok:false,message:e.message};}
}
function modifyRecoveryPlan(planId,user,updates){
 if(!role(user))return{ok:false,message:'Access denied: Unauthorized role to modify recovery plans.'};
 try{db.exec('BEGIN IMMEDIATE');const p=get('SELECT * FROM recovery_plans WHERE id=?',Number(planId));if(!p)throw new Error('Plan not found.');if(!['operational','synthetic_demo'].includes(p.data_origin))throw new Error('This record cannot be modified.');if(p.created_by_id&&Number(p.created_by_id)!==Number(user.id))throw new Error('Only the plan creator can modify this draft.');if(!['Draft','Rejected','Changes Requested','Approved'].includes(p.status))throw new Error(`Cannot modify plan in '${p.status}' state.`);
  const title=updates.title===undefined?p.title:String(updates.title||'').trim(),description=updates.description===undefined?String(p.description||''):String(updates.description||''),rationale=updates.rationale===undefined?String(p.rationale||''):String(updates.rationale||'');const quantity=updates.quantity===undefined?p.quantity:Number(updates.quantity),cost=updates.estimated_cost===undefined||updates.estimated_cost===null?p.estimated_cost:Number(updates.estimated_cost);if(!title||title.length>160)throw new Error('Plan title must contain 1 to 160 characters.');if(description.length>1200||rationale.length>1200)throw new Error('Plan description and rationale must be 1,200 characters or fewer.');if(!Number.isInteger(quantity)||quantity<=0)throw new Error('Quantity must be a positive integer greater than zero.');if(!Number.isFinite(cost)||cost<0)throw new Error('Estimated cost cannot be negative.');
  const invalidated=p.status==='Approved',nextStatus=invalidated||p.status==='Rejected'?'Draft':p.status;run(`UPDATE recovery_plans SET title=?,quantity=?,estimated_cost=?,description=?,rationale=?,version=version+1,created_by_id=COALESCE(created_by_id,?),data_origin='operational',cost_estimate_verified=CASE WHEN ? THEN 1 ELSE cost_estimate_verified END,status=?,approval_version=CASE WHEN ? THEN NULL ELSE approval_version END,updated_at=? WHERE id=?`,title,quantity,cost,description,rationale,user.id,updates.estimated_cost!==undefined&&updates.estimated_cost!==null?1:0,nextStatus,invalidated?1:0,nowIso(),p.id);
  if(invalidated)run("UPDATE approvals SET status='Pending',comments='Approval invalidated due to post-approval plan modification.',approver_id=NULL,decision_at=NULL WHERE recovery_plan_id=? AND status='Approved' AND data_origin='operational'",p.id);
  const updated=get('SELECT * FROM recovery_plans WHERE id=?',p.id);audit({userId:user.id,action:'MODIFY_RECOVERY_PLAN',entityType:'RecoveryPlan',entityId:p.id,details:`Plan ${p.plan_code} updated to v${updated.version}.${invalidated?' Previous approval invalidated.':''}`});db.exec('COMMIT');return{ok:true,message:`Plan ${p.plan_code} modified successfully (now v${updated.version}).${invalidated?' Previous approval invalidated; please resubmit.':p.status==='Rejected'?' Rejected plan returned to Draft; resubmit for approval.':''}`};
 }catch(e){try{db.exec('ROLLBACK')}catch{}return{ok:false,message:e.message};}
}
function executeSimulatedRecoveryPlan(planId,user,{idempotencyKey,confirmation}){
 const plan=get('SELECT * FROM recovery_plans WHERE id=?',Number(planId));
 if(!plan)return{ok:false,message:'Recovery plan not found.'};
 if(plan.data_origin!=='operational')return{ok:false,message:'Reference templates cannot be executed.'};
 const token=String(idempotencyKey||'').trim();
 if(!token)return{ok:false,message:'A valid execution idempotency key is required.'};
 if(plan.status==='Executed')return{ok:false,message:`Plan ${plan.plan_code} has already been executed. Duplicate execution rejected.`};
 if(get('SELECT id FROM recovery_plans WHERE execution_idempotency_key=?',token))return{ok:false,message:'Duplicate execution token detected. This action has already been processed.'};
 if(!confirmation)return{ok:false,message:'Explicit execution confirmation is required before simulated execution can proceed.'};
 if(!['Approved','Execution Ready'].includes(plan.status))return{ok:false,message:`Plan is in '${plan.status}' status. Only Approved plans can be executed.`};
 if(!(plan.status==='Approved'&&plan.approval_version===plan.version))return{ok:false,message:`Plan approval invalid: current version (v${plan.version}) does not match approved version (v${plan.approval_version}). Re-approval is required.`};
 const approvedDecision=get("SELECT * FROM approvals WHERE recovery_plan_id=? AND status='Approved' AND data_origin='operational' ORDER BY decision_at DESC LIMIT 1",plan.id);if(!approvedDecision||approvedDecision.approver_id==null||approvedDecision.approver_id===approvedDecision.requester_id||approvedDecision.requester_id!==plan.created_by_id)return{ok:false,message:'A valid independent Recovery Manager approval record is required before execution.'};
 if(!executorRole(user)){
  audit({userId:user.id,action:'UNAUTHORIZED_EXECUTION_ATTEMPT',entityType:'RecoveryPlan',entityId:plan.id,details:`User ${user.username} with role '${user.role}' attempted execution without permission.`});
  return{ok:false,message:`Access denied: Role '${user.role}' is not authorized to execute recovery plans.`};
 }
 const now=nowIso();
 const details={plan_code:plan.plan_code,strategy_type:plan.strategy_type,executed_by:user.username,executed_by_role:user.role,executed_at:now,simulation_mode:true,inventory_movements:[],disruption_update:null,order_updates:[]};
 try{
  db.exec('BEGIN IMMEDIATE');
  const current=get('SELECT * FROM recovery_plans WHERE id=?',plan.id);
  if(!current||current.status!==plan.status||current.version!==plan.version)throw new Error('Recovery plan changed while execution was being prepared. Refresh and retry.');
  const liveApproval=get("SELECT * FROM approvals WHERE recovery_plan_id=? AND status='Approved' AND data_origin='operational' ORDER BY decision_at DESC LIMIT 1",current.id);if(!liveApproval||liveApproval.approver_id==null||liveApproval.approver_id===liveApproval.requester_id||liveApproval.requester_id!==current.created_by_id||current.approval_version!==current.version)throw new Error('Independent approval is no longer valid. Execution aborted.');
  if(!get('SELECT id FROM disruptions WHERE id=?',current.disruption_id))throw new Error('Linked disruption no longer exists. Execution aborted.');
  if(get('SELECT id FROM recovery_plans WHERE execution_idempotency_key=?',token))throw new Error('Duplicate execution token detected. This action has already been processed.');
  if(current.strategy_type==='Inter-Warehouse Stock Transfer'){
   const src=get('SELECT i.*,w.code AS warehouse_code FROM inventories i LEFT JOIN warehouses w ON w.id=i.warehouse_id WHERE i.warehouse_id=? AND i.sku=?',current.source_warehouse_id,current.sku);
   if(!src)throw new Error(`Source inventory record for SKU ${current.sku} at warehouse ${current.source_warehouse_id} not found.`);
   const srcAvail=Math.max(0,src.quantity-src.reserved_quantity);
   if(srcAvail<current.quantity)throw new Error(`Insufficient available stock at source warehouse (${srcAvail} available vs ${current.quantity} required). Execution aborted.`);
   if(srcAvail-current.quantity<src.reorder_point)throw new Error(`Transfer would breach the source warehouse reorder point (${src.reorder_point}). Execution aborted.`);
   const srcHub=get('SELECT is_active FROM warehouses WHERE id=?',current.source_warehouse_id),destHub=get('SELECT is_active FROM warehouses WHERE id=?',current.destination_warehouse_id);
   if(!srcHub?.is_active||!destHub?.is_active)throw new Error('Both source and destination warehouses must be active.');
   if(current.source_warehouse_id===current.destination_warehouse_id)throw new Error('Source and destination warehouses must be different.');
   let dest=get('SELECT i.*,w.code AS warehouse_code FROM inventories i LEFT JOIN warehouses w ON w.id=i.warehouse_id WHERE i.warehouse_id=? AND i.sku=?',current.destination_warehouse_id,current.sku);
   if(!dest){
    const ins=run(`INSERT INTO inventories(warehouse_id,sku,item_name,category,quantity,reserved_quantity,reorder_point,unit_cost,updated_at) VALUES(?,?,?,?,0,0,?,?,?)`,current.destination_warehouse_id,current.sku,src.item_name,src.category,src.reorder_point,src.unit_cost,now);
    dest=get('SELECT i.*,w.code AS warehouse_code FROM inventories i LEFT JOIN warehouses w ON w.id=i.warehouse_id WHERE i.id=?',Number(ins.lastInsertRowid));
   }
   const srcBefore=src.quantity,destBefore=dest.quantity;
   run('UPDATE inventories SET quantity=quantity-?,updated_at=? WHERE id=?',current.quantity,now,src.id);
   run('UPDATE inventories SET quantity=quantity+?,updated_at=? WHERE id=?',current.quantity,now,dest.id);
   const movementCode=`MOV-${current.plan_code}-${Date.now()}`;
   run(`INSERT INTO stock_movements(movement_code,recovery_plan_id,sku,source_warehouse_id,destination_warehouse_id,quantity,movement_type,recorded_by_id,created_at,data_origin) VALUES(?,?,?,?,?,?,'RECOVERY_TRANSFER',?,?, 'simulated')`,movementCode,current.id,current.sku,current.source_warehouse_id,current.destination_warehouse_id,current.quantity,user.id,now);
   details.inventory_movements.push({movement_code:movementCode,sku:current.sku,transferred_quantity:current.quantity,source_warehouse:src.warehouse_code||String(current.source_warehouse_id),source_quantity_before:srcBefore,source_quantity_after:srcBefore-current.quantity,destination_warehouse:dest.warehouse_code||String(current.destination_warehouse_id),destination_quantity_before:destBefore,destination_quantity_after:destBefore+current.quantity});
   details.operational_effect_note='Inventory balance movement is recorded as simulated. No customer order status or disruption status is changed because physical receipt and fulfilment have not been verified.';
  }else if(current.strategy_type==='Alternative Supplier'){
   details.simulated_purchase_order={sku:current.sku,quantity:current.quantity,supplier:current.source_location,destination_hub:current.destination_location,estimated_freight_cost:current.estimated_cost,dispatch_status:'SIMULATED_PO_DISPATCHED',inventory_note:'On-hand inventory unchanged pending simulated receiving intake.'};
  }else if(current.strategy_type==='Expedited Freight'){
   details.simulated_freight_reroute={tracking_reference:`REROUTE-${current.plan_code}`,expedited_mode:'Air Express Charter (Simulated)',delay_recovered_hours:current.estimated_delay_reduction_hours,surcharge:current.estimated_cost,carrier_note:'Simulated carrier flight dispatch; no live airline API called.'};
  }else if(current.strategy_type==='Order Reprioritisation'){
   const linked=all(`SELECT o.id,o.order_number,o.status FROM customer_orders o JOIN disruption_affected_orders x ON x.customer_order_id=o.id WHERE x.disruption_id=?`,current.disruption_id);
   for(const order of linked)details.order_updates.push({order_number:order.order_number,priority_status:'Re-sequenced for critical manufacturing delivery'});
  }else if(current.strategy_type==='Split Allocation'){
   details.split_shipment={sku:current.sku,immediate_release_quantity:current.quantity,status:'PARTIAL_DISPATCH_SIMULATED'};
  }
  run("UPDATE recovery_actions SET status='Completed',executed_at=?,result_details=? WHERE recovery_plan_id=?",now,`Executed via ${current.strategy_type} simulation.`,current.id);
  run(`UPDATE recovery_plans SET status='Executed',progress=100,executed_by_id=?,executed_at=?,execution_idempotency_key=?,execution_notes=?,execution_result_json=?,updated_at=? WHERE id=?`,user.id,now,token,`Simulated execution confirmed by ${user.username} (${user.role}) on ${now}.`,JSON.stringify(details),now,current.id);
  audit({userId:user.id,action:'EXECUTE_RECOVERY_PLAN',entityType:'RecoveryPlan',entityId:current.id,details:`Plan ${current.plan_code} (${current.strategy_type}) successfully executed in simulation mode by ${user.username}.`});
  run(`INSERT INTO notifications(recipient_role,title,message,category,is_read,created_at) VALUES(?,?,?,?,0,?)`,'HUB_INCHARGE',`Recovery Plan Executed: ${current.plan_code}`,`Simulated execution for ${current.title} completed successfully by ${user.username}. No physical delivery or carrier movement is implied.`,'Info',now);
  const customerOrders=all(`SELECT DISTINCT o.id,o.order_number,o.customer_id FROM customer_orders o JOIN disruption_affected_orders x ON x.customer_order_id=o.id WHERE x.disruption_id=?`,current.disruption_id);
  for(const order of customerOrders){if(!order.customer_id)continue;const recipients=all(`SELECT id FROM users WHERE customer_id=? AND role='CUSTOMER' AND is_active=1`,order.customer_id);for(const recipient of recipients){run(`INSERT INTO notifications(recipient_role,recipient_user_id,title,message,category,is_read,created_at,customer_order_id,disruption_id,recovery_plan_id,data_origin) VALUES('CUSTOMER',?,?,?,?,0,?,?,?,?,'simulated')`,recipient.id,`Recovery action recorded for ${order.order_number}`,`A simulated recovery action (${current.title}) has been recorded for the disruption affecting your order. This is a planning-system update only and does not confirm physical shipment movement or delivery.`, 'Recovery',now,order.id,current.disruption_id,current.id);}}
  db.exec('COMMIT');
  return{ok:true,message:`Recovery plan ${current.plan_code} successfully executed (simulation mode).`,details};
 }catch(e){try{db.exec('ROLLBACK');}catch{}return{ok:false,message:e.message};}
}
module.exports={PERMITTED,generateRecoveryRecommendations,createPlanFromRecommendation,submitPlanForApproval,reviewPlanApproval,modifyRecoveryPlan,executeSimulatedRecoveryPlan};
