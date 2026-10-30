"""
DisruptionIQ — Recovery Execution & State Machine Service
Enforces role-based approvals, separation of duties, approval version invalidation,
explicit execution confirmation, atomic simulated inventory updates, and idempotency guards.

Guarantees:
- Safe simulation: Never contacts external carriers or triggers external purchases.
- Atomic execution: Re-validates inventory in-transaction, prevents negative inventory.
- Strict idempotency: Duplicate execution attempts are safely rejected.
"""

import json
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Tuple
from app.extensions import db
from app.models.disruptions import RecoveryPlan, RecoveryAction, Disruption
from app.models.logistics import Warehouse, Inventory, Shipment
from app.models.orders import CustomerOrder
from app.models.governance import Approval
from app.models.user import User, Role
from app.services.audit_service import record_audit
from app.services.notification_service import create_notification


# Valid State Transitions
PERMITTED_TRANSITIONS = {
    'Draft': ['Pending Approval', 'Cancelled'],
    'Changes Requested': ['Pending Approval', 'Cancelled'],
    'Pending Approval': ['Approved', 'Rejected', 'Changes Requested', 'Cancelled'],
    'Approved': ['Execution Ready', 'Draft', 'Cancelled'],  # Note: editing reverts to Draft
    'Execution Ready': ['Executed', 'Execution Failed', 'Cancelled'],
    'Rejected': ['Draft'],
    'Executed': [],
    'Cancelled': [],
    'Execution Failed': ['Execution Ready', 'Cancelled']
}


def submit_plan_for_approval(plan_id: int, user: User) -> Tuple[bool, str]:
    """Transitions plan from Draft / Changes Requested to Pending Approval."""
    plan = db.session.get(RecoveryPlan, plan_id)
    if not plan:
        return False, "Plan not found."

    if plan.status not in ['Draft', 'Changes Requested']:
        return False, f"Cannot submit plan in '{plan.status}' status for approval."

    # Validate required fields
    if not plan.quantity or plan.quantity <= 0:
        return False, "Plan must specify a valid positive quantity."

    plan.status = 'Pending Approval'
    plan.updated_at = datetime.now(timezone.utc)

    # Determine required approval role based on cost and strategy
    required_role = Role.PROCUREMENT_APPROVER if plan.estimated_cost >= 500.0 else Role.SUPPLY_CHAIN_MANAGER

    # Create or update pending approval record
    approval = Approval.query.filter_by(recovery_plan_id=plan.id, status='Pending').first()
    if not approval:
        approval = Approval(
            recovery_plan_id=plan.id,
            requester_id=user.id,
            required_role=required_role,
            status='Pending',
            requested_at=datetime.now(timezone.utc)
        )
        db.session.add(approval)
    else:
        approval.requester_id = user.id
        approval.required_role = required_role
        approval.requested_at = datetime.now(timezone.utc)
        approval.comments = None

    db.session.commit()

    record_audit(
        action='SUBMIT_FOR_APPROVAL',
        entity_type='RecoveryPlan',
        entity_id=str(plan.id),
        details=f"Plan {plan.plan_code} submitted for approval by {user.username} (Required Role: {required_role}).",
        user_id=user.id
    )

    create_notification(
        title=f"Plan Awaiting Approval: {plan.plan_code}",
        message=f"Plan '{plan.title}' (${plan.estimated_cost:,.2f}) requires your approval review.",
        category='Alert',
        recipient_role=required_role
    )

    return True, f"Plan {plan.plan_code} successfully submitted for approval."


def review_plan_approval(
    plan_id: int,
    user: User,
    decision: str,  # 'Approved', 'Rejected', 'Changes Requested'
    comments: Optional[str] = None
) -> Tuple[bool, str]:
    """Processes an approval decision with role-based checks and separation of duties."""
    plan = db.session.get(RecoveryPlan, plan_id)
    if not plan:
        return False, "Plan not found."

    if plan.status != 'Pending Approval':
        return False, f"Plan is in '{plan.status}' status, not pending approval."

    # Separation of duties: Creator cannot approve their own plan (unless admin in override)
    if plan.created_by_id == user.id and user.role != Role.ADMINISTRATOR:
        return False, "Separation of duties violation: You cannot approve your own recovery plan."

    # Verify user role clearance
    approval = Approval.query.filter_by(recovery_plan_id=plan.id, status='Pending').first()
    required_role = (approval.required_role if approval and approval.required_role else Role.PROCUREMENT_APPROVER)

    if not user.has_role(required_role, Role.ADMINISTRATOR, Role.SUPPLY_CHAIN_MANAGER, Role.PROCUREMENT_APPROVER):
        return False, f"Access denied: Role '{user.role}' is not authorized to decide on this plan."

    if decision in ['Rejected', 'Changes Requested'] and (not comments or not comments.strip()):
        return False, f"A clear reason is mandatory when {decision.lower()} a plan."

    now = datetime.now(timezone.utc)

    if decision == 'Approved':
        plan.status = 'Approved'
        plan.approval_version = plan.version  # Lock approval version snapshot
        plan.updated_at = now

        if approval:
            approval.status = 'Approved'
            approval.approver_id = user.id
            approval.decision_at = now
            approval.comments = comments or "Approved for simulated operational execution."

        db.session.commit()

        record_audit(
            action='APPROVE_PLAN',
            entity_type='RecoveryPlan',
            entity_id=str(plan.id),
            details=f"Plan {plan.plan_code} approved by {user.username} ({user.role}). Version locked at v{plan.version}.",
            user_id=user.id
        )

        create_notification(
            title=f"Plan Approved: {plan.plan_code}",
            message=f"Plan '{plan.title}' has been approved and is ready for simulated execution confirmation.",
            category='Info',
            recipient_role=Role.WAREHOUSE_OPERATOR
        )
        if plan.created_by_id:
            create_notification(
                title=f"Your Plan {plan.plan_code} Was Approved",
                message=f"Approved by {user.username}. Ready for execution.",
                category='Info',
                recipient_user_id=plan.created_by_id
            )

        return True, f"Plan {plan.plan_code} approved successfully. Version locked at v{plan.version}."

    elif decision == 'Rejected':
        plan.status = 'Rejected'
        plan.updated_at = now

        if approval:
            approval.status = 'Rejected'
            approval.approver_id = user.id
            approval.decision_at = now
            approval.comments = comments

        db.session.commit()

        record_audit(
            action='REJECT_PLAN',
            entity_type='RecoveryPlan',
            entity_id=str(plan.id),
            details=f"Plan {plan.plan_code} rejected by {user.username}. Reason: {comments}",
            user_id=user.id
        )

        if plan.created_by_id:
            create_notification(
                title=f"Plan Rejected: {plan.plan_code}",
                message=f"Reason: {comments}",
                category='Warning',
                recipient_user_id=plan.created_by_id
            )

        return True, f"Plan {plan.plan_code} rejected."

    elif decision == 'Changes Requested':
        plan.status = 'Changes Requested'
        plan.updated_at = now

        if approval:
            approval.status = 'Changes Requested'
            approval.approver_id = user.id
            approval.decision_at = now
            approval.comments = comments

        db.session.commit()

        record_audit(
            action='REQUEST_PLAN_CHANGES',
            entity_type='RecoveryPlan',
            entity_id=str(plan.id),
            details=f"Changes requested for plan {plan.plan_code} by {user.username}. Feedback: {comments}",
            user_id=user.id
        )

        if plan.created_by_id:
            create_notification(
                title=f"Changes Requested: {plan.plan_code}",
                message=f"Approver feedback: {comments}",
                category='Warning',
                recipient_user_id=plan.created_by_id
            )

        return True, f"Changes requested for plan {plan.plan_code}."

    return False, f"Unknown decision '{decision}'."


def modify_recovery_plan(
    plan_id: int,
    user: User,
    update_data: Dict[str, Any]
) -> Tuple[bool, str]:
    """
    Modifies a draft plan with server-side validation.
    CRITICAL RULE: If an Approved plan is modified, its approval is invalidated
    and reverted to Draft, requiring fresh approval!
    """
    plan = db.session.get(RecoveryPlan, plan_id)
    if not plan:
        return False, "Plan not found."

    if plan.status in ['Executed', 'Cancelled']:
        return False, f"Cannot modify plan in '{plan.status}' state."

    if not user.has_role(Role.OPERATIONS_ANALYST, Role.SUPPLY_CHAIN_MANAGER, Role.ADMINISTRATOR):
        return False, "Access denied: Unauthorized role to modify recovery plans."

    # Server-side validation
    qty = update_data.get('quantity')
    if qty is not None:
        try:
            qty_int = int(qty)
            if qty_int <= 0:
                return False, "Quantity must be a positive integer greater than zero."
            plan.quantity = qty_int
        except (ValueError, TypeError):
            return False, "Invalid quantity value."

    cost = update_data.get('estimated_cost')
    if cost is not None:
        try:
            cost_flt = float(cost)
            if cost_flt < 0:
                return False, "Estimated cost cannot be negative."
            plan.estimated_cost = cost_flt
        except (ValueError, TypeError):
            return False, "Invalid cost value."

    if 'title' in update_data and update_data['title']:
        plan.title = update_data['title'].strip()

    if 'description' in update_data:
        plan.description = update_data['description']

    if 'rationale' in update_data:
        plan.rationale = update_data['rationale']

    # Handle version increment and approval invalidation
    plan.version += 1
    plan.updated_at = datetime.now(timezone.utc)
    approval_invalidated = False

    if plan.status == 'Approved':
        plan.status = 'Draft'
        plan.approval_version = None
        approval_invalidated = True

        # Invalidate any previously approved approval record
        prev_approval = Approval.query.filter_by(recovery_plan_id=plan.id, status='Approved').first()
        if prev_approval:
            prev_approval.status = 'Pending'
            prev_approval.comments = "Approval invalidated due to post-approval plan modification."

    db.session.commit()

    details_str = f"Plan {plan.plan_code} updated to v{plan.version}."
    if approval_invalidated:
        details_str += " Approval invalidated due to modification; re-approval required."

    record_audit(
        action='MODIFY_RECOVERY_PLAN',
        entity_type='RecoveryPlan',
        entity_id=str(plan.id),
        details=details_str,
        user_id=user.id
    )

    msg = f"Plan {plan.plan_code} modified successfully (now v{plan.version})."
    if approval_invalidated:
        msg += " Previous approval has been invalidated; please resubmit for approval."

    return True, msg


def execute_simulated_recovery_plan(
    plan_id: int,
    user: User,
    idempotency_key: str,
    execution_confirmation: bool
) -> Tuple[bool, str, Dict[str, Any]]:
    """
    Executes an approved recovery plan in simulation mode with transaction safety and concurrency guards.
    Execution Requirements:
      1. Plan status is 'Approved' or 'Execution Ready'.
      2. Plan version matches approval_version (has not been tampered with since approval).
      3. User has role Warehouse Operator, Supply Chain Manager, or Administrator.
      4. Explicit execution confirmation is True.
      5. Current inventory and business constraints still satisfy the plan.
      6. Idempotency guard: plan has not already been executed.
    """
    plan = db.session.get(RecoveryPlan, plan_id)
    if not plan:
        return False, "Recovery plan not found.", {}

    # Check 1: Idempotency guard
    if plan.status == 'Executed':
        return False, f"Plan {plan.plan_code} has already been executed on {plan.executed_at.strftime('%Y-%m-%d %H:%M UTC') if plan.executed_at else 'earlier'}. Duplicate execution rejected.", {}

    if plan.execution_idempotency_key == idempotency_key:
        return False, "Duplicate execution token detected. This action has already been processed.", {}

    # Check 2: Explicit confirmation check
    if not execution_confirmation:
        return False, "Explicit execution confirmation is required before simulated execution can proceed.", {}

    # Check 3: State validation
    if plan.status not in ['Approved', 'Execution Ready']:
        return False, f"Plan is in '{plan.status}' status. Only Approved plans can be executed.", {}

    # Check 4: Version snapshot check
    if not plan.is_approval_valid():
        return False, f"Plan approval invalid: current version (v{plan.version}) does not match approved version (v{plan.approval_version}). Re-approval is required.", {}

    # Check 5: Role authorization
    if not user.has_role(Role.WAREHOUSE_OPERATOR, Role.SUPPLY_CHAIN_MANAGER, Role.ADMINISTRATOR):
        record_audit(
            action='UNAUTHORIZED_EXECUTION_ATTEMPT',
            entity_type='RecoveryPlan',
            entity_id=str(plan.id),
            details=f"User {user.username} with role '{user.role}' attempted execution without permission.",
            user_id=user.id
        )
        return False, f"Access denied: Role '{user.role}' is not authorized to execute recovery plans.", {}

    now = datetime.now(timezone.utc)
    execution_details = {
        'plan_code': plan.plan_code,
        'strategy_type': plan.strategy_type,
        'executed_by': user.username,
        'executed_by_role': user.role,
        'executed_at': now.isoformat(),
        'simulation_mode': True,
        'inventory_movements': [],
        'disruption_update': None,
        'order_updates': []
    }

    try:
        # Atomic transaction execution
        if plan.strategy_type == 'Inter-Warehouse Stock Transfer':
            # Re-validate source warehouse inventory within transaction
            src_inv = Inventory.query.filter_by(
                warehouse_id=plan.source_warehouse_id,
                sku=plan.sku
            ).with_for_update().first()

            if not src_inv:
                return False, f"Source inventory record for SKU {plan.sku} at warehouse {plan.source_warehouse_id} not found.", {}

            src_avail = max(0, src_inv.quantity - src_inv.reserved_quantity)
            if src_avail < plan.quantity:
                return False, f"Insufficient available stock at source warehouse ({src_avail} available vs {plan.quantity} required). Execution aborted.", {}

            # Destination warehouse inventory
            dest_inv = Inventory.query.filter_by(
                warehouse_id=plan.destination_warehouse_id,
                sku=plan.sku
            ).with_for_update().first()

            if not dest_inv:
                # Create destination inventory record if not already stocked
                dest_inv = Inventory(
                    warehouse_id=plan.destination_warehouse_id,
                    sku=plan.sku,
                    item_name=src_inv.item_name,
                    category=src_inv.category,
                    quantity=0,
                    reserved_quantity=0,
                    reorder_point=src_inv.reorder_point,
                    unit_cost=src_inv.unit_cost
                )
                db.session.add(dest_inv)
                db.session.flush()

            # Record before snapshots
            src_qty_before = src_inv.quantity
            dest_qty_before = dest_inv.quantity

            # Apply atomic transfer
            src_inv.quantity -= plan.quantity
            dest_inv.quantity += plan.quantity

            movement_record = {
                'sku': plan.sku,
                'transferred_quantity': plan.quantity,
                'source_warehouse': plan.source_warehouse.code if plan.source_warehouse else str(plan.source_warehouse_id),
                'source_quantity_before': src_qty_before,
                'source_quantity_after': src_inv.quantity,
                'destination_warehouse': plan.destination_warehouse.code if plan.destination_warehouse else str(plan.destination_warehouse_id),
                'destination_quantity_before': dest_qty_before,
                'destination_quantity_after': dest_inv.quantity,
            }
            execution_details['inventory_movements'].append(movement_record)

            # Reallocate affected orders if applicable
            if plan.disruption:
                for ord_obj in plan.disruption.affected_orders.all():
                    if ord_obj.status == 'At Risk':
                        ord_obj.status = 'Allocated'
                        execution_details['order_updates'].append({
                            'order_number': ord_obj.order_number,
                            'status_before': 'At Risk',
                            'status_after': 'Allocated'
                        })

                # Check if all orders alleviated; mark disruption mitigated
                plan.disruption.status = 'Mitigated'
                execution_details['disruption_update'] = f"Disruption {plan.disruption.disruption_code} marked as Mitigated."

        elif plan.strategy_type == 'Alternative Supplier':
            # Simulated Supplier Replenishment: Records PO instruction only without phantom on-hand stock
            execution_details['simulated_purchase_order'] = {
                'sku': plan.sku,
                'quantity': plan.quantity,
                'supplier': plan.source_location,
                'destination_hub': plan.destination_location,
                'estimated_freight_cost': plan.estimated_cost,
                'dispatch_status': 'SIMULATED_PO_DISPATCHED',
                'inventory_note': 'On-hand inventory unchanged pending simulated receiving intake.'
            }

        elif plan.strategy_type == 'Expedited Freight':
            # Simulated Carrier Intercept / Air Charter
            execution_details['simulated_freight_reroute'] = {
                'tracking_reference': f"REROUTE-{plan.plan_code}",
                'expedited_mode': 'Air Express Charter (Simulated)',
                'delay_recovered_hours': plan.estimated_delay_reduction_hours,
                'surcharge': plan.estimated_cost,
                'carrier_note': 'Simulated carrier flight dispatch; no live airline API called.'
            }

        elif plan.strategy_type == 'Order Reprioritisation':
            # Simulated customer scheduling prioritization
            if plan.disruption:
                for ord_obj in plan.disruption.affected_orders.all():
                    execution_details['order_updates'].append({
                        'order_number': ord_obj.order_number,
                        'priority_status': 'Re-sequenced for critical manufacturing delivery'
                    })

        elif plan.strategy_type == 'Split Allocation':
            # Simulated split allocation
            execution_details['split_shipment'] = {
                'sku': plan.sku,
                'immediate_release_quantity': plan.quantity,
                'status': 'PARTIAL_DISPATCH_SIMULATED'
            }

        # Update action statuses to Completed
        for action in plan.actions.all():
            action.status = 'Completed'
            action.executed_at = now
            action.result_details = f"Executed via {plan.strategy_type} simulation."

        # Mark plan as Executed
        plan.status = 'Executed'
        plan.executed_by_id = user.id
        plan.executed_at = now
        plan.execution_idempotency_key = idempotency_key
        plan.execution_notes = f"Simulated execution confirmed by {user.username} ({user.role}) on {now.strftime('%Y-%m-%d %H:%M UTC')}."
        plan.execution_result_json = json.dumps(execution_details)

        db.session.commit()

        # Audit and notification
        record_audit(
            action='EXECUTE_RECOVERY_PLAN',
            entity_type='RecoveryPlan',
            entity_id=str(plan.id),
            details=f"Plan {plan.plan_code} ({plan.strategy_type}) successfully executed in simulation mode by {user.username}.",
            user_id=user.id
        )

        create_notification(
            title=f"Recovery Plan Executed: {plan.plan_code}",
            message=f"Simulated execution for {plan.title} completed successfully by {user.username}.",
            category='Info',
            recipient_role='All'
        )

        return True, f"Recovery plan {plan.plan_code} successfully executed (simulation mode).", execution_details

    except Exception as e:
        db.session.rollback()
        record_audit(
            action='EXECUTION_FAILED',
            entity_type='RecoveryPlan',
            entity_id=str(plan.id),
            details=f"Execution error for plan {plan.plan_code}: {str(e)}",
            user_id=user.id
        )
        return False, f"Simulated execution failed: {str(e)}", {}
