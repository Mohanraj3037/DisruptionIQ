"""
Isolated Verification Script for Phase 4 Checks 3, 4, and 5
Runs entirely on an in-memory / temporary isolated database without touching instance/disruptioniq.db.
"""
import sys
import os
import uuid
from datetime import datetime, timezone

# Ensure project root is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from flask import Flask
from app.extensions import db
from app.models.user import User, Role
from app.models.logistics import Warehouse, Inventory, Supplier, Shipment
from app.models.orders import CustomerOrder, OrderItem
from app.models.disruptions import Disruption, RecoveryPlan, RecoveryAction
from app.models.governance import Approval, AuditLog, Notification
from app.services.auth_service import seed_demo_accounts
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

# Set up test app with in-memory SQLite
test_app = Flask(__name__)
test_app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///:memory:'
test_app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
test_app.config['TESTING'] = True
db.init_app(test_app)

results = {}

with test_app.app_context():
    db.create_all()
    seed_demo_accounts()

    analyst = User.query.filter_by(username='analyst').first()
    manager = User.query.filter_by(username='manager').first()
    approver = User.query.filter_by(username='approver').first()
    warehouse_op = User.query.filter_by(username='warehouse').first()
    admin = User.query.filter_by(username='admin').first()

    # Seed isolated entities
    wh_east = Warehouse(code='WH-EAST', name='East Coast Hub', location='Newark, NJ', capacity_sqm=10000.0)
    wh_central = Warehouse(code='WH-CENTRAL', name='Central Hub', location='Chicago, IL', capacity_sqm=15000.0)
    db.session.add_all([wh_east, wh_central])
    db.session.commit()

    # Inventories: Central has 100 on hand, 20 reserved, 20 reorder_point -> Usable surplus = 60
    inv_east = Inventory(
        warehouse_id=wh_east.id,
        sku='SKU-ROUTER-X',
        item_name='High Performance Core Router',
        quantity=5,
        reserved_quantity=5,
        reorder_point=15,
        unit_cost=200.0
    )
    inv_central = Inventory(
        warehouse_id=wh_central.id,
        sku='SKU-ROUTER-X',
        item_name='High Performance Core Router',
        quantity=100,
        reserved_quantity=20,
        reorder_point=20,
        unit_cost=200.0
    )
    db.session.add_all([inv_east, inv_central])

    supplier = Supplier(
        code='SUP-TECH',
        name='Apex Optical Systems',
        country='Japan',
        lead_time_days=3,
        reliability_score=0.94
    )
    db.session.add(supplier)
    db.session.commit()

    disruption = Disruption(
        disruption_code='DIS-VERIFY-001',
        title='Hub Shortage for Core Router',
        disruption_type='Inventory Shortage',
        shortage_category='Confirmed Shortage',
        severity='Critical',
        status='Active',
        warehouse_id=wh_east.id,
        location='Newark Hub',
        estimated_delay_hours=72
    )
    db.session.add(disruption)
    db.session.commit()

    order = CustomerOrder(
        order_number='ORD-VERIFY-101',
        customer_name='Enterprise Networks Corp',
        customer_tier='Tier 1',
        status='At Risk',
        priority='High',
        total_value=12000.0,
        assigned_warehouse_id=wh_east.id
    )
    db.session.add(order)
    db.session.commit()

    item = OrderItem(
        order_id=order.id,
        sku='SKU-ROUTER-X',
        item_name='High Performance Core Router',
        quantity=30,
        unit_price=400.0
    )
    db.session.add(item)
    disruption.affected_orders.append(order)
    db.session.commit()

    print("\n--- 1. Testing Recommendation Engine & Quality ---")
    options = generate_recovery_recommendations(disruption.id)
    strategy_types_found = [o['strategy_type'] for o in options]
    print(f"Candidate options generated: {len(options)}")
    for o in options:
        print(f"  [{o['rank']}] {o['strategy_type']}: {o['title']} (Score: {o['recommendation_score']:.1f}, Cost: ${o['estimated_cost']:.2f}, Feasibility: {o['feasibility']})")

    # Verify Strategy Types
    has_stock_transfer = any('Stock Transfer' in o['strategy_type'] for o in options)
    has_alt_supplier = any('Supplier' in o['strategy_type'] for o in options)
    has_reprioritise = any('Reprioritisation' in o['strategy_type'] for o in options)
    results['rec_engine_strategies'] = has_stock_transfer and has_alt_supplier and has_reprioritise

    # Verify surplus respect
    st_option = next(o for o in options if o['strategy_type'] == 'Inter-Warehouse Stock Transfer')
    results['rec_surplus_respected'] = (st_option['quantity'] == 30 and st_option['source_warehouse_id'] == wh_central.id)

    # Verify deterministic ranking ordering
    scores = [o['recommendation_score'] for o in options]
    results['rec_deterministic_ranking'] = (scores == sorted(scores, reverse=True))

    # Verify duplicate plan prevention
    created_plan = create_plan_from_recommendation(disruption.id, st_option, analyst.id)
    dup_plan = create_plan_from_recommendation(disruption.id, st_option, analyst.id)
    total_plans = RecoveryPlan.query.filter_by(disruption_id=disruption.id).count()
    results['rec_duplicate_prevention'] = (created_plan is not None and dup_plan.id == created_plan.id and total_plans == 1)
    print(f"Plan creation: {created_plan.plan_code}; Duplicate returned existing ID: {dup_plan.id} (Total plans in DB: {total_plans})")

    print("\n--- 2. Testing Approval Workflow State Machine ---")
    plan = created_plan

    # State: Draft -> Pending Approval
    sub_ok, sub_msg = submit_plan_for_approval(plan.id, analyst)
    results['submit_pending_approval'] = (sub_ok and plan.status == 'Pending Approval')

    # Separation of Duties: Creator cannot approve their own plan
    self_apprv_ok, self_msg = review_plan_approval(plan.id, analyst, 'Approved', 'Self-approval test')
    results['separation_of_duties'] = (not self_apprv_ok and "Separation of duties" in self_msg)

    # Unauthorized role cannot approve (Warehouse Operator)
    unauth_apprv_ok, unauth_msg = review_plan_approval(plan.id, warehouse_op, 'Approved', 'Warehouse approval test')
    results['unauthorized_approval_blocked'] = (not unauth_apprv_ok and "Access denied" in unauth_msg)

    # Rejection requires mandatory reason
    rej_fail_ok, rej_fail_msg = review_plan_approval(plan.id, approver, 'Rejected', '   ')
    results['rejection_requires_reason'] = (not rej_fail_ok and "mandatory" in rej_fail_msg.lower())

    # Valid rejection
    rej_ok, rej_msg = review_plan_approval(plan.id, approver, 'Rejected', 'Exceeds regional budget threshold')
    results['valid_rejection_state'] = (rej_ok and plan.status == 'Rejected')

    # Re-submit after rejection
    plan.status = 'Draft'
    db.session.commit()
    submit_plan_for_approval(plan.id, analyst)

    # Changes Requested requires mandatory reason
    cr_fail_ok, cr_fail_msg = review_plan_approval(plan.id, approver, 'Changes Requested', '')
    results['changes_requested_requires_reason'] = (not cr_fail_ok and "mandatory" in cr_fail_msg.lower())

    # Valid Changes Requested
    cr_ok, cr_msg = review_plan_approval(plan.id, approver, 'Changes Requested', 'Please reduce transfer quantity to 25 units')
    results['valid_changes_requested_state'] = (cr_ok and plan.status == 'Changes Requested')

    # Re-submit and approve
    submit_plan_for_approval(plan.id, analyst)
    apprv_ok, apprv_msg = review_plan_approval(plan.id, approver, 'Approved', 'Transfer authorized')
    results['valid_approval_state'] = (apprv_ok and plan.status == 'Approved' and plan.approval_version == 1)

    # Post-approval modification invalidates approval
    mod_ok, mod_msg = modify_recovery_plan(plan.id, manager, {'quantity': 25, 'title': 'Updated Transfer to 25 units'})
    results['post_approval_edit_invalidates'] = (mod_ok and plan.status == 'Draft' and plan.approval_version is None and plan.version == 2)

    # Re-submit and approve version 2
    submit_plan_for_approval(plan.id, analyst)
    review_plan_approval(plan.id, approver, 'Approved', 'Re-approved version 2')
    results['reapproval_locks_version_2'] = (plan.status == 'Approved' and plan.approval_version == 2)

    print("\n--- 3. Testing Simulated Execution Safeguards ---")

    # Blocked without explicit confirmation
    idem_key1 = f"IDEM-{uuid.uuid4().hex[:12]}"
    no_conf_ok, no_conf_msg, _ = execute_simulated_recovery_plan(plan.id, warehouse_op, idem_key1, execution_confirmation=False)
    results['exec_blocked_without_confirmation'] = (not no_conf_ok and "Explicit execution confirmation" in no_conf_msg)

    # Blocked if version out of sync (tampering simulation)
    plan.version = 3  # Tamper with version without updating approval_version
    db.session.commit()
    tamper_ok, tamper_msg, _ = execute_simulated_recovery_plan(plan.id, warehouse_op, idem_key1, execution_confirmation=True)
    results['exec_blocked_on_tampered_version'] = (not tamper_ok and "Plan approval invalid" in tamper_msg)
    plan.version = 2  # Restore version
    db.session.commit()

    # Blocked for unauthorized role (Operations Analyst cannot execute)
    unauth_exec_ok, unauth_exec_msg, _ = execute_simulated_recovery_plan(plan.id, analyst, idem_key1, execution_confirmation=True)
    results['exec_blocked_unauthorized_role'] = (not unauth_exec_ok and "Access denied" in unauth_exec_msg)

    # Blocked if inventory becomes insufficient before execution
    inv_central.quantity = 10  # Less than required 25 units
    db.session.commit()
    insuf_ok, insuf_msg, _ = execute_simulated_recovery_plan(plan.id, warehouse_op, idem_key1, execution_confirmation=True)
    results['exec_blocked_insufficient_inventory'] = (not insuf_ok and "Insufficient available stock" in insuf_msg)
    inv_central.quantity = 100  # Restore stock
    db.session.commit()

    # Valid execution succeeds
    src_pre = inv_central.quantity
    dest_pre = inv_east.quantity
    exec_ok, exec_msg, exec_details = execute_simulated_recovery_plan(plan.id, warehouse_op, idem_key1, execution_confirmation=True)
    results['exec_successful_transfer'] = (exec_ok and plan.status == 'Executed')
    results['exec_atomic_inventory_move'] = (inv_central.quantity == src_pre - 25 and inv_east.quantity == dest_pre + 25)
    results['exec_order_status_allocated'] = (order.status == 'Allocated')

    # Duplicate execution prevention (Idempotency Key Guard)
    dup_exec_ok, dup_exec_msg, _ = execute_simulated_recovery_plan(plan.id, warehouse_op, idem_key1, execution_confirmation=True)
    results['exec_duplicate_prevented'] = (not dup_exec_ok and "already been executed" in dup_exec_msg)
    results['exec_stock_not_doubled'] = (inv_central.quantity == src_pre - 25)

    print("\n--- 4. Testing Audit Trail & In-App Notifications ---")
    audits = AuditLog.query.filter_by(entity_type='RecoveryPlan').all()
    audit_actions = [a.action for a in audits]
    print(f"Recorded recovery audits ({len(audits)}): {audit_actions}")
    results['audit_actions_complete'] = all(act in audit_actions for act in [
        'SUBMIT_FOR_APPROVAL', 'APPROVE_PLAN', 'REJECT_PLAN', 'REQUEST_PLAN_CHANGES',
        'MODIFY_RECOVERY_PLAN', 'EXECUTE_RECOVERY_PLAN'
    ])

    notifs = Notification.query.all()
    print(f"Recorded in-app notifications ({len(notifs)})")
    results['notifications_created'] = len(notifs) > 0

    print("\n--- 5. Verification Results Summary ---")
    all_passed = True
    for test_name, passed in results.items():
        status_str = "PASS" if passed else "FAIL"
        if not passed:
            all_passed = False
        print(f"  [{status_str}] {test_name}")

    print(f"\nFinal Isolated Workflow Outcome: {'ALL TESTS PASSED' if all_passed else 'SOME TESTS FAILED'}")
