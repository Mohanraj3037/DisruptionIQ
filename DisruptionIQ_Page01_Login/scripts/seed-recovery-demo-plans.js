'use strict';
const {db,get,all,run,nowIso}=require('../src/database');
const hub=get("SELECT id FROM users WHERE role='HUB_INCHARGE' AND is_active=1 ORDER BY id LIMIT 1");
if(!hub){console.log('Recovery demo drafts skipped: no active Hub In-Charge account.');db.close();process.exit(0);}
const now=nowIso();let seeded=0;
for(const d of all("SELECT d.id,d.disruption_code,d.title,d.severity,COUNT(DISTINCT x.customer_order_id) AS order_count,MIN(x.customer_order_id) AS sample_order_id FROM disruptions d JOIN disruption_affected_orders x ON x.disruption_id=d.id WHERE d.status IN ('Active','Investigating') GROUP BY d.id HAVING COUNT(DISTINCT x.customer_order_id)>0 ORDER BY CASE d.severity WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END,d.detected_at DESC LIMIT 3")){
 const code=`DEMO-PLAN-${String(d.id).padStart(5,'0')}`;
 if(get('SELECT id FROM recovery_plans WHERE plan_code=?',code))continue;
 const qty=Math.max(1,Number(d.order_count||1));
 const title=`Order service reprioritisation · ${d.disruption_code}`;
 const result=run(`INSERT INTO recovery_plans(plan_code,disruption_id,customer_order_id,title,strategy_type,status,quantity,estimated_cost,cost_estimate_verified,description,rationale,version,created_by_id,created_at,updated_at,protected_value,priority,progress,data_origin) VALUES(?,?,?,?,'Order Reprioritisation','Draft',?,0,0,?,?,1,?,?,?,0,?,0,'synthetic_demo')`,code,d.id,d.sample_order_id,title,qty,`Demo draft template for ${qty} explicitly linked customer orders.`, `Review stored order priority and delivery deadlines for ${d.disruption_code}. This is a draft only; no order or inventory records are changed.`,hub.id,now,now,String(d.severity||'Medium'));
 const planId=Number(result.lastInsertRowid);
 run(`INSERT INTO recovery_actions(recovery_plan_id,action_sequence,action_type,description,status,cost,assigned_to_role,data_origin) VALUES(?,1,'ORDER_REPRIORITISATION',?,'Pending',0,'HUB_INCHARGE','synthetic_demo')`,planId,`Review and rank ${qty} explicitly linked customer orders after approval.`);
 run(`INSERT INTO recovery_actions(recovery_plan_id,action_sequence,action_type,description,status,cost,assigned_to_role,data_origin) VALUES(?,2,'CUSTOMER_COMMUNICATION_REVIEW',?,'Pending',0,'HUB_INCHARGE','synthetic_demo')`,planId,'Prepare customer communication after service sequence review.');
 seeded++;
}
const notices=[
 ['HUB_INCHARGE','Recovery drafts are ready','Synthetic draft plans are available in Recovery Planning. Review the evidence, edit a draft and submit it for independent Recovery Manager approval.','Info'],
 ['RISK_ANALYST','Risk workspace ready','Disruption scans create randomized synthetic signal overlays. Operational incident counts remain derived from the database.','Info'],
 ['RECOVERY_MANAGER','Recovery review workflow ready','Submitted plans appear in Approval Queue. You can approve, reject or request changes; you cannot approve your own plan.','Info'],
 ['CUSTOMER','Customer portal ready','Your customer workspace shows only records associated with your customer account.','Info']
];
for(const [role,title,message,category] of notices){if(!get("SELECT id FROM notifications WHERE recipient_role=? AND title=? AND data_origin='synthetic_demo'",role,title))run("INSERT INTO notifications(recipient_role,title,message,category,is_read,created_at,data_origin) VALUES(?,?,?,?,0,?,'synthetic_demo')",role,title,message,category,now);}
console.log(`Recovery bootstrap complete: ${seeded} draft plan(s) created; role notifications ensured.`);
db.close();
