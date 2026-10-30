from flask import Blueprint, render_template, jsonify
from flask_login import login_required
from app.extensions import db
from app.models.disruptions import Disruption, RecoveryPlan
from app.models.logistics import Shipment, Inventory
from app.models.orders import CustomerOrder
from app.models.governance import Approval, AuditLog
from app.services.risk_scoring_service import score_and_rank_all_affected_orders

dashboard_bp = Blueprint('dashboard', __name__)


@dashboard_bp.route('/')
@login_required
def index():
    # 1. Live KPI Metrics from SQLite
    active_disruptions_count = Disruption.query.filter(
        Disruption.status.in_(['Active', 'Investigating'])
    ).count()

    delayed_shipments_count = Shipment.query.filter_by(status='Delayed').count()

    low_inventory_count = Inventory.query.filter(
        (Inventory.quantity - Inventory.reserved_quantity) <= Inventory.reorder_point
    ).count()

    pending_approvals_count = Approval.query.filter_by(status='Pending').count()

    potential_shortages_count = Disruption.query.filter_by(
        shortage_category='Potential Shortage',
        status='Active'
    ).count()

    confirmed_shortages_count = Disruption.query.filter_by(
        shortage_category='Confirmed Shortage',
        status='Active'
    ).count()

    affected_orders_count = CustomerOrder.query.filter_by(status='At Risk').count()

    # 2. Risk Engine Evaluation: Ranked At-Risk Orders and Distribution
    all_scored_orders = score_and_rank_all_affected_orders()

    critical_count = sum(1 for o in all_scored_orders if o['severity'] == 'Critical')
    high_count = sum(1 for o in all_scored_orders if o['severity'] == 'High')
    medium_count = sum(1 for o in all_scored_orders if o['severity'] == 'Medium')
    low_count = sum(1 for o in all_scored_orders if o['severity'] == 'Low')

    top_risk_orders = all_scored_orders[:5]

    # 3. Highest-Risk Active Disruptions (ordered by severity: Critical > High > Medium > Low)
    severity_rank_map = {'Critical': 1, 'High': 2, 'Medium': 3, 'Low': 4}
    active_disruptions = Disruption.query.filter(
        Disruption.status.in_(['Active', 'Investigating'])
    ).all()
    highest_risk_disruptions = sorted(
        active_disruptions,
        key=lambda d: (severity_rank_map.get(d.severity, 5), -(d.estimated_delay_hours or 0))
    )[:6]

    # Phase 4: Recovery Planning, Governance & Simulation Metrics
    pending_recovery_plans_count = RecoveryPlan.query.filter_by(status='Pending Approval').count()
    approved_recovery_plans_count = RecoveryPlan.query.filter(
        RecoveryPlan.status.in_(['Approved', 'Execution Ready'])
    ).count()
    executed_recovery_plans_count = RecoveryPlan.query.filter_by(status='Executed').count()
    failed_recovery_plans_count = RecoveryPlan.query.filter_by(status='Execution Failed').count()
    active_recovery_cost = db.session.query(db.func.sum(RecoveryPlan.estimated_cost)).filter(
        RecoveryPlan.status.in_(['Draft', 'Pending Approval', 'Approved', 'Execution Ready'])
    ).scalar() or 0.0

    recent_recovery_plans = RecoveryPlan.query.order_by(RecoveryPlan.created_at.desc()).limit(5).all()
    recent_governance_actions = AuditLog.query.filter(
        AuditLog.entity_type.in_(['RecoveryPlan', 'Approval'])
    ).order_by(AuditLog.timestamp.desc()).limit(6).all()

    metrics = {
        'active_disruptions': active_disruptions_count,
        'delayed_shipments': delayed_shipments_count,
        'potential_shortages': potential_shortages_count,
        'confirmed_shortages': confirmed_shortages_count,
        'affected_orders': affected_orders_count,
        'critical_high_risk_orders': critical_count + high_count,
        'critical_orders': critical_count,
        'high_orders': high_count,
        'medium_orders': medium_count,
        'low_orders': low_count,
        'low_inventory': low_inventory_count,
        'pending_approvals': pending_approvals_count,
        # Phase 4 additions
        'pending_recovery_plans': pending_recovery_plans_count,
        'approved_recovery_plans': approved_recovery_plans_count,
        'executed_recovery_plans': executed_recovery_plans_count,
        'failed_recovery_plans': failed_recovery_plans_count,
        'active_recovery_cost': active_recovery_cost,
    }

    recent_orders = CustomerOrder.query.order_by(
        CustomerOrder.order_date.desc()
    ).limit(6).all()

    return render_template(
        'dashboard/index.html',
        metrics=metrics,
        recent_disruptions=highest_risk_disruptions,
        top_risk_orders=top_risk_orders,
        recent_orders=recent_orders,
        recent_recovery_plans=recent_recovery_plans,
        recent_governance_actions=recent_governance_actions,
    )


@dashboard_bp.route('/api/dashboard-charts')
@login_required
def dashboard_charts():
    """Returns dynamic chart aggregations for the frontend Chart.js components."""
    # 1. Disruption Breakdown by Severity
    severity_order = ['Critical', 'High', 'Medium', 'Low']
    severity_counts = {}
    for sev in severity_order:
        severity_counts[sev] = Disruption.query.filter_by(severity=sev).count()

    # 2. Shipment Breakdown by Status
    shipment_statuses = ['In Transit', 'Delayed', 'Scheduled', 'Delivered']
    shipment_counts = {}
    for st in shipment_statuses:
        shipment_counts[st] = Shipment.query.filter_by(status=st).count()

    # 3. Order Risk Distribution from Deterministic Engine
    all_scored = score_and_rank_all_affected_orders()
    risk_distribution = {
        'Critical': sum(1 for o in all_scored if o['severity'] == 'Critical'),
        'High': sum(1 for o in all_scored if o['severity'] == 'High'),
        'Medium': sum(1 for o in all_scored if o['severity'] == 'Medium'),
        'Low': sum(1 for o in all_scored if o['severity'] == 'Low'),
    }

    return jsonify({
        'disruptions_by_severity': {
            'labels': list(severity_counts.keys()),
            'data': list(severity_counts.values()),
        },
        'shipments_by_status': {
            'labels': list(shipment_counts.keys()),
            'data': list(shipment_counts.values()),
        },
        'risk_distribution': {
            'labels': list(risk_distribution.keys()),
            'data': list(risk_distribution.values()),
        }
    })
