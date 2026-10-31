"""
DisruptionIQ — Recovery Planning & Approval Workflow Routes
Provides full-featured views and APIs for candidate option generation,
side-by-side comparison, draft plan creation/editing, role-based approval queue,
explicit execution confirmation, and simulated execution.
"""

import uuid
from flask import Blueprint, render_template, request, redirect, url_for, flash, jsonify, abort
from flask_login import login_required, current_user
from app.extensions import db
from app.models.user import Role
from app.models.disruptions import Disruption, RecoveryPlan, RecoveryAction
from app.models.orders import CustomerOrder
from app.models.governance import Approval, AuditLog
from app.models.logistics import Warehouse, Inventory, Supplier
from app.services.auth_service import role_required
from app.services.recovery_planning_service import (
    generate_recovery_recommendations,
    create_plan_from_recommendation
)
from app.services.recovery_execution_service import (
    submit_plan_for_approval,
    review_plan_approval,
    modify_recovery_plan,
    execute_simulated_recovery_plan
)

recovery_bp = Blueprint('recovery', __name__)


@recovery_bp.route('/recovery-plans', methods=['GET'])
@login_required
@role_required(Role.OPERATIONS_ANALYST, Role.SUPPLY_CHAIN_MANAGER, Role.PROCUREMENT_APPROVER)
def index():
    """
    Renders the Recovery Plans overview page.
    Displays active plans, candidate generation options, and filtering controls.
    Title contains 'Recovery Plans & Mitigation' for regression compatibility.
    """
    status_filter = request.args.get('status', 'all').strip()
    disruption_filter = request.args.get('disruption_id', '').strip()
    strategy_filter = request.args.get('strategy', 'all').strip()

    query = RecoveryPlan.query

    if status_filter and status_filter.lower() != 'all':
        query = query.filter(RecoveryPlan.status.ilike(status_filter))

    if disruption_filter.isdigit():
        query = query.filter(RecoveryPlan.disruption_id == int(disruption_filter))

    if strategy_filter and strategy_filter.lower() != 'all':
        query = query.filter(RecoveryPlan.strategy_type.ilike(f'%{strategy_filter}%'))

    plans = query.order_by(RecoveryPlan.created_at.desc()).all()

    # Active disruptions for candidate generator
    active_disruptions = Disruption.query.filter(
        Disruption.status.in_(['Active', 'Investigating'])
    ).order_by(Disruption.detected_at.desc()).all()

    counts = {
        'total': RecoveryPlan.query.count(),
        'draft': RecoveryPlan.query.filter_by(status='Draft').count(),
        'pending': RecoveryPlan.query.filter_by(status='Pending Approval').count(),
        'approved': RecoveryPlan.query.filter_by(status='Approved').count(),
        'executed': RecoveryPlan.query.filter_by(status='Executed').count(),
    }

    return render_template(
        'recovery/index.html',
        plans=plans,
        active_disruptions=active_disruptions,
        counts=counts,
        current_status=status_filter,
        current_disruption_id=int(disruption_filter) if disruption_filter.isdigit() else None,
        current_strategy=strategy_filter
    )


@recovery_bp.route('/recovery-plans/compare/<int:disruption_id>', methods=['GET'], endpoint='compare_candidates')
@recovery_bp.route('/recovery-plans/compare-options/<int:disruption_id>', methods=['GET'], endpoint='compare_options')
@login_required
@role_required(Role.OPERATIONS_ANALYST, Role.SUPPLY_CHAIN_MANAGER, Role.PROCUREMENT_APPROVER)
def compare_candidates(disruption_id: int):
    """
    Generates and displays side-by-side comparison of candidate recovery options
    for a specific disruption, ranked by deterministic operational scoring.
    """
    disruption = db.session.get(Disruption, disruption_id)
    if not disruption:
        abort(404)

    candidates = generate_recovery_recommendations(disruption_id)

    # Check for existing plans linked to this disruption
    existing_plans = RecoveryPlan.query.filter_by(disruption_id=disruption_id).all()

    return render_template(
        'recovery/compare.html',
        disruption=disruption,
        candidates=candidates,
        existing_plans=existing_plans
    )


@recovery_bp.route('/recovery-plans/create-from-candidate', methods=['POST'])
@login_required
@role_required(Role.OPERATIONS_ANALYST, Role.SUPPLY_CHAIN_MANAGER)
def create_from_candidate():
    """Creates a formal draft RecoveryPlan from a selected candidate recommendation option."""
    disruption_id = request.form.get('disruption_id', type=int)
    option_id = request.form.get('option_id', '')

    if not disruption_id:
        flash("Invalid disruption reference.", "danger")
        return redirect(url_for('recovery.index'))

    candidates = generate_recovery_recommendations(disruption_id)
    selected_option = next((c for c in candidates if c['option_id'] == option_id), None)

    if not selected_option:
        flash("Selected recovery recommendation option was not found.", "warning")
        return redirect(url_for('recovery.compare_candidates', disruption_id=disruption_id))

    try:
        plan = create_plan_from_recommendation(disruption_id, selected_option, current_user.id)
        flash(f"Recovery Plan '{plan.plan_code}' generated in Draft state. Review proposed actions and submit for approval.", "success")
        return redirect(url_for('recovery.plan_detail', plan_id=plan.id))
    except Exception as e:
        flash(f"Error creating plan: {str(e)}", "danger")
        return redirect(url_for('recovery.compare_candidates', disruption_id=disruption_id))


@recovery_bp.route('/recovery-plans/<int:plan_id>', methods=['GET'])
@login_required
def plan_detail(plan_id: int):
    """Renders the detailed view of a single RecoveryPlan with actions and approval history."""
    plan = db.session.get(RecoveryPlan, plan_id)
    if not plan:
        abort(404)

    # Allow Warehouse Operator, Analyst, Manager, Approver, Admin to inspect detail
    if not current_user.has_role(Role.WAREHOUSE_OPERATOR, Role.OPERATIONS_ANALYST, Role.SUPPLY_CHAIN_MANAGER, Role.PROCUREMENT_APPROVER, Role.ADMINISTRATOR):
        abort(403)

    actions = plan.actions.order_by(RecoveryAction.action_sequence.asc()).all()
    approvals = plan.approvals.order_by(Approval.requested_at.desc()).all()
    audit_trail = AuditLog.query.filter_by(entity_type='RecoveryPlan', entity_id=str(plan.id)).order_by(AuditLog.timestamp.desc()).all()

    return render_template(
        'recovery/detail.html',
        plan=plan,
        actions=actions,
        approvals=approvals,
        audit_trail=audit_trail
    )


@recovery_bp.route('/recovery-plans/<int:plan_id>/edit', methods=['POST'])
@login_required
@role_required(Role.OPERATIONS_ANALYST, Role.SUPPLY_CHAIN_MANAGER)
def edit_plan(plan_id: int):
    """
    Modifies a draft or rejected plan.
    If the plan was previously approved, approval is automatically invalidated.
    """
    plan = db.session.get(RecoveryPlan, plan_id)
    if not plan:
        abort(404)

    update_data = {
        'title': request.form.get('title'),
        'quantity': request.form.get('quantity'),
        'estimated_cost': request.form.get('estimated_cost'),
        'description': request.form.get('description'),
        'rationale': request.form.get('rationale')
    }

    success, message = modify_recovery_plan(plan_id, current_user, update_data)
    if success:
        flash(message, "success")
    else:
        flash(message, "danger")

    return redirect(url_for('recovery.plan_detail', plan_id=plan.id))


@recovery_bp.route('/recovery-plans/<int:plan_id>/submit-approval', methods=['POST'])
@login_required
@role_required(Role.OPERATIONS_ANALYST, Role.SUPPLY_CHAIN_MANAGER)
def submit_approval(plan_id: int):
    """Transitions plan to Pending Approval."""
    success, message = submit_plan_for_approval(plan_id, current_user)
    if success:
        flash(message, "success")
    else:
        flash(message, "danger")

    return redirect(url_for('recovery.plan_detail', plan_id=plan_id))


@recovery_bp.route('/approvals', methods=['GET'])
@login_required
@role_required(Role.PROCUREMENT_APPROVER, Role.SUPPLY_CHAIN_MANAGER)
def approvals():
    """
    Governance queue for Procurement Approver and Supply Chain Manager.
    Displays plans awaiting approval decision.
    """
    pending_approvals = Approval.query.filter_by(status='Pending').order_by(Approval.requested_at.desc()).all()
    history = Approval.query.filter(Approval.status.in_(['Approved', 'Rejected', 'Changes Requested'])).order_by(Approval.decision_at.desc()).limit(20).all()

    return render_template(
        'recovery/approvals.html',
        pending_approvals=pending_approvals,
        history=history
    )


@recovery_bp.route('/recovery-plans/<int:plan_id>/decision', methods=['POST'])
@login_required
@role_required(Role.PROCUREMENT_APPROVER, Role.SUPPLY_CHAIN_MANAGER)
def approval_decision(plan_id: int):
    """Processes approval, rejection, or request for changes with comments."""
    decision = request.form.get('decision', '').strip()  # 'Approved', 'Rejected', 'Changes Requested'
    comments = request.form.get('comments', '').strip()

    success, message = review_plan_approval(plan_id, current_user, decision, comments)
    if success:
        flash(message, "success" if decision == 'Approved' else "warning")
    else:
        flash(message, "danger")

    # Redirect to approvals queue if came from there, otherwise to detail
    return_to = request.form.get('return_to', 'detail')
    if return_to == 'queue':
        return redirect(url_for('recovery.approvals'))
    return redirect(url_for('recovery.plan_detail', plan_id=plan_id))


@recovery_bp.route('/recovery-plans/<int:plan_id>/confirm-execution', methods=['GET'])
@login_required
@role_required(Role.WAREHOUSE_OPERATOR, Role.SUPPLY_CHAIN_MANAGER)
def confirm_execution(plan_id: int):
    """
    Displays the explicit pre-execution confirmation screen.
    Summarises the exact proposed inventory movements, costs, and safety constraints.
    Generates a secure, single-use idempotency key.
    """
    plan = db.session.get(RecoveryPlan, plan_id)
    if not plan:
        abort(404)

    if plan.status not in ['Approved', 'Execution Ready']:
        flash(f"Plan is in '{plan.status}' status. Only Approved plans can proceed to execution confirmation.", "warning")
        return redirect(url_for('recovery.plan_detail', plan_id=plan.id))

    if not plan.is_approval_valid():
        flash("Plan approval is invalid because plan content was modified after approval. Re-approval required.", "danger")
        return redirect(url_for('recovery.plan_detail', plan_id=plan.id))

    # Pre-flight check on inventory
    src_inv = None
    dest_inv = None
    if plan.strategy_type == 'Inter-Warehouse Stock Transfer':
        src_inv = Inventory.query.filter_by(warehouse_id=plan.source_warehouse_id, sku=plan.sku).first()
        dest_inv = Inventory.query.filter_by(warehouse_id=plan.destination_warehouse_id, sku=plan.sku).first()

    # Generate a fresh idempotency key for this confirmation attempt
    idempotency_key = f"IDEM-{plan.plan_code}-{uuid.uuid4().hex[:12].upper()}"

    return render_template(
        'recovery/confirm_execution.html',
        plan=plan,
        src_inv=src_inv,
        dest_inv=dest_inv,
        idempotency_key=idempotency_key
    )


@recovery_bp.route('/recovery-plans/<int:plan_id>/execute', methods=['POST'])
@login_required
@role_required(Role.WAREHOUSE_OPERATOR, Role.SUPPLY_CHAIN_MANAGER)
def execute_plan(plan_id: int):
    """
    Executes an approved recovery plan in simulated mode.
    Requires explicit confirmation checkbox and idempotency key.
    """
    idempotency_key = request.form.get('idempotency_key', '').strip()
    confirmation = request.form.get('confirm_checkbox') == 'yes'

    if not confirmation:
        flash("You must explicitly verify the confirmation checkbox before executing.", "danger")
        return redirect(url_for('recovery.confirm_execution', plan_id=plan_id))

    success, message, details = execute_simulated_recovery_plan(
        plan_id=plan_id,
        user=current_user,
        idempotency_key=idempotency_key,
        execution_confirmation=confirmation
    )

    if success:
        flash(message, "success")
        return redirect(url_for('recovery.plan_detail', plan_id=plan_id))
    else:
        flash(message, "danger")
        return redirect(url_for('recovery.confirm_execution', plan_id=plan_id))


@recovery_bp.route('/api/recovery-plans', methods=['GET'])
@login_required
def api_recovery_plans():
    """Read-only JSON API returning list of recovery plans and their execution status."""
    plans = RecoveryPlan.query.order_by(RecoveryPlan.created_at.desc()).all()
    results = []
    for p in plans:
        results.append({
            'id': p.id,
            'plan_code': p.plan_code,
            'title': p.title,
            'disruption_code': p.disruption.disruption_code if p.disruption else 'N/A',
            'strategy_type': p.strategy_type,
            'status': p.status,
            'sku': p.sku,
            'quantity': p.quantity,
            'source_location': p.source_location,
            'destination_location': p.destination_location,
            'estimated_cost': p.estimated_cost,
            'estimated_delay_reduction_hours': p.estimated_delay_reduction_hours,
            'version': p.version,
            'approval_version': p.approval_version,
            'is_approval_valid': p.is_approval_valid(),
            'created_at': p.created_at.isoformat(),
            'executed_at': p.executed_at.isoformat() if p.executed_at else None
        })

    return jsonify({
        'success': True,
        'count': len(results),
        'plans': results
    }), 200
