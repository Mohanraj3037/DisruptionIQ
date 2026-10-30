'use strict';
// Imported spreadsheet records are evidence/reference data, never live decisions,
// approvals, carrier callbacks, application audit events, or actionable plans.
const {db,get,all,run,nowIso}=require('../src/database');

db.exec(`CREATE TABLE IF NOT EXISTS synthetic_reference_records(
  source_type TEXT NOT NULL, source_id TEXT NOT NULL, payload_json TEXT NOT NULL,
  archived_at TEXT NOT NULL, PRIMARY KEY(source_type,source_id)
)`);
function archive(type,id,payload){
  run(`INSERT OR IGNORE INTO synthetic_reference_records(source_type,source_id,payload_json,archived_at) VALUES(?,?,?,?)`,type,String(id),JSON.stringify(payload),nowIso());
}
let stats={};
db.exec('BEGIN IMMEDIATE');
try {
  const legacyApprovals=all(`SELECT a.* FROM approvals a LEFT JOIN recovery_plans p ON p.id=a.recovery_plan_id
    LEFT JOIN users req ON req.id=a.requester_id LEFT JOIN users decider ON decider.id=a.approver_id
    WHERE COALESCE(a.data_origin,'synthetic')='synthetic' OR COALESCE(p.data_origin,'synthetic')='synthetic'
      OR req.email LIKE '%@dataset.disruptioniq.local' OR decider.email LIKE '%@dataset.disruptioniq.local'`);
  legacyApprovals.forEach(r=>archive('legacy_approval',r.id,r));
  run(`DELETE FROM approvals WHERE id IN (SELECT a.id FROM approvals a LEFT JOIN recovery_plans p ON p.id=a.recovery_plan_id
    LEFT JOIN users req ON req.id=a.requester_id LEFT JOIN users decider ON decider.id=a.approver_id
    WHERE COALESCE(a.data_origin,'synthetic')='synthetic' OR COALESCE(p.data_origin,'synthetic')='synthetic'
      OR req.email LIKE '%@dataset.disruptioniq.local' OR decider.email LIKE '%@dataset.disruptioniq.local')`);

  const legacyAudit=all(`SELECT a.* FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
    WHERE COALESCE(a.data_origin,'synthetic')='synthetic' OR u.email LIKE '%@dataset.disruptioniq.local'
      OR upper(COALESCE(a.details,'')) LIKE '%SYNTHETIC DATASET EVENT%'`);
  legacyAudit.forEach(r=>archive('legacy_audit_event',r.id,r));
  run(`DELETE FROM audit_logs WHERE id IN (SELECT a.id FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
    WHERE COALESCE(a.data_origin,'synthetic')='synthetic' OR u.email LIKE '%@dataset.disruptioniq.local'
      OR upper(COALESCE(a.details,'')) LIKE '%SYNTHETIC DATASET EVENT%')`);

  const legacyNotifications=all(`SELECT n.* FROM notifications n LEFT JOIN users u ON u.id=n.recipient_user_id
    WHERE COALESCE(n.data_origin,'synthetic')='synthetic' OR u.email LIKE '%@dataset.disruptioniq.local'`);
  legacyNotifications.forEach(r=>archive('legacy_notification',r.id,r));
  run(`DELETE FROM notifications WHERE id IN (SELECT n.id FROM notifications n LEFT JOIN users u ON u.id=n.recipient_user_id
    WHERE COALESCE(n.data_origin,'synthetic')='synthetic' OR u.email LIKE '%@dataset.disruptioniq.local')`);

  const legacyWebhooks=all(`SELECT * FROM webhook_events WHERE COALESCE(data_origin,'synthetic')='synthetic'`);
  legacyWebhooks.forEach(r=>archive('legacy_carrier_event',r.id,r));
  run(`DELETE FROM webhook_events WHERE COALESCE(data_origin,'synthetic')='synthetic'`);

  const legacyPlans=all(`SELECT * FROM recovery_plans WHERE COALESCE(data_origin,'synthetic')='synthetic'`);
  for(const plan of legacyPlans){
    archive('legacy_recovery_plan_template',plan.plan_code||plan.id,plan);
    const actions=all('SELECT * FROM recovery_actions WHERE recovery_plan_id=?',plan.id);
    actions.forEach(a=>archive('legacy_recovery_action',a.id,a));
    const moves=all('SELECT * FROM stock_movements WHERE recovery_plan_id=?',plan.id);
    moves.forEach(m=>archive('legacy_stock_movement',m.id,m));
    run('DELETE FROM stock_movements WHERE recovery_plan_id=?',plan.id);
  }
  // Child action rows cascade from recovery_plans; remove imported drafts so they
  // cannot be mistaken for real user-created recovery work.
  run(`DELETE FROM recovery_plans WHERE COALESCE(data_origin,'synthetic')='synthetic'`);

  // Normalise old imported percentages to a 0–1 reliability fraction.
  run(`UPDATE suppliers SET reliability_score=MIN(1,MAX(0,reliability_score/100.0)) WHERE reliability_score>1`);
  // Retrospectively populate risk scores on datasets imported by earlier builds.
  run(`UPDATE shipments AS s SET risk_score=ROUND(MIN(99,MAX(5,COALESCE(
    (SELECT AVG(r.source_risk_score) FROM source_order_risks r
      JOIN disruption_affected_orders x ON x.customer_order_id=r.order_id
      JOIN disruptions d ON d.id=x.disruption_id WHERE d.shipment_id=s.id),
    (CASE s.status WHEN 'Delayed' THEN 66 WHEN 'In Transit' THEN 43 WHEN 'Scheduled' THEN 30 WHEN 'Delivered' THEN 15 ELSE 35 END)
      + (1-COALESCE((SELECT sp.reliability_score FROM suppliers sp WHERE sp.id=s.supplier_id),0.85))*28
      + CASE WHEN EXISTS(SELECT 1 FROM disruptions dx WHERE dx.shipment_id=s.id AND dx.severity IN ('Critical','High') AND dx.status IN ('Active','Investigating')) THEN 7 ELSE 0 END
  ))),1) WHERE s.risk_score IS NULL OR s.risk_score<=0`);

  run(`UPDATE users SET is_active=0 WHERE email LIKE '%@dataset.disruptioniq.local'`);
  stats={archived_approvals:legacyApprovals.length,archived_audit_events:legacyAudit.length,
    archived_notifications:legacyNotifications.length,archived_carrier_events:legacyWebhooks.length,
    archived_recovery_plan_templates:legacyPlans.length,
    live_pending_approvals:Number(get("SELECT COUNT(*) n FROM approvals WHERE status='Pending' AND data_origin='operational'").n||0),
    live_recovery_plans:Number(get("SELECT COUNT(*) n FROM recovery_plans WHERE data_origin='operational'").n||0),
    live_audit_events:Number(get("SELECT COUNT(*) n FROM audit_logs WHERE data_origin='operational'").n||0)};
  db.exec('COMMIT');
} catch(error){try{db.exec('ROLLBACK')}catch{}throw error;}
console.log(JSON.stringify(stats,null,2));
db.close();
