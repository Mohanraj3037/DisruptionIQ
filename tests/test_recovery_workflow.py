import unittest
import uuid
from datetime import datetime, timezone
from app.extensions import db
from app.models.user import User, Role
from app.models.logistics import Warehouse, Inventory, Supplier
from app.models.orders import CustomerOrder, OrderItem
from app.models.disruptions import Disruption, RecoveryPlan, RecoveryAction
from app.models.governance import Approval, AuditLog, Notification
from app.services.auth_service import seed_demo_accounts
from app.services.recovery_execution_service import (
    submit_plan_for_approval,
    review_plan_approval,
    modify_recovery_plan,
    execute_simulated_recovery_plan
)
from tests.test_base import BaseTestCase


class TestRecoveryWorkflow(BaseTestCase):
    """
    Test suite for Modules C, D, E, F:
    Plan modifications, role-based approval state machine, separation of duties,
    explicit confirmation, atomic simulated execution, idempotency, audit trail, and notifications.
    """

    def setUp(self):
        super().setUp()
        seed_demo_accounts()

        self.analyst = User.query.filter_by(username='analyst').first()
        self.manager = User.query.filter_by(username='manager').first()
        self.approver = User.query.filter_by(username='approver').first()
        self.warehouse = User.query.filter_by(username='warehouse').first()
        self.admin = User.query.filter_by(username='admin').first()

        # Seed Warehouses
        self.wh_east = Warehouse(code='WH-EAST', name='East Coast Hub', location='Newark, NJ', capacity_sqm=10000.0)
        self.wh_central = Warehouse(code='WH-CENTRAL', name='Central Hub', location='Chicago, IL', capacity_sqm=15000.0)
        db.session.add_all([self.wh_east, self.wh_central])
        db.session.commit()

        # Seed Inventories
        self.inv_east = Inventory(
            warehouse_id=self.wh_east.id,
            sku='SKU-ROUTER-01',
            item_name='Enterprise Core Router',
            quantity=10,
            reserved_quantity=10,
            reorder_point=20,
            unit_cost=150.0
        )
        self.inv_central = Inventory(
            warehouse_id=self.wh_central.id,
            sku='SKU-ROUTER-01',
            item_name='Enterprise Core Router',
            quantity=120,
            reserved_quantity=20,
            reorder_point=30,  # Surplus = 120 - 20 - 30 = 70 units
            unit_cost=150.0
        )
        db.session.add_all([self.inv_east, self.inv_central])
        db.session.commit()

        # Seed Disruption & Customer Order
        self.disruption = Disruption(
            disruption_code='DIS-TEST-900',
            title='Transit Shortage at East Coast Hub',
            disruption_type='Inventory Shortage',
            shortage_category='Confirmed Shortage',
            severity='High',
            status='Active',
            warehouse_id=self.wh_east.id,
            location='Newark Hub',
            estimated_delay_hours=48
        )
        db.session.add(self.disruption)
        db.session.commit()

        self.order = CustomerOrder(
            order_number='ORD-TEST-901',
            customer_name='Global Tech',
            customer_tier='Tier 1',
            status='At Risk',
            priority='High',
            total_value=6000.0,
            assigned_warehouse_id=self.wh_east.id
        )
        db.session.add(self.order)
        db.session.commit()

        self.item = OrderItem(
            order_id=self.order.id,
            sku='SKU-ROUTER-01',
            item_name='Enterprise Core Router',
            quantity=40,
            unit_price=150.0
        )
        db.session.add(self.item)
        self.disruption.affected_orders.append(self.order)
        db.session.commit()

        # Create a baseline draft RecoveryPlan
        self.plan = RecoveryPlan(
            plan_code='REC-TEST-900-01',
            disruption_id=self.disruption.id,
            customer_order_id=self.order.id,
            title='Stock Transfer from Central to East Hub',
            strategy_type='Inter-Warehouse Stock Transfer',
            status='Draft',
            sku='SKU-ROUTER-01',
            quantity=40,
            source_warehouse_id=self.wh_central.id,
            destination_warehouse_id=self.wh_east.id,
            source_location='WH-CENTRAL (Chicago, IL)',
            destination_location='WH-EAST (Newark, NJ)',
            estimated_cost=320.0,
            estimated_delay_reduction_hours=36,
            rationale='Transfer 40 surplus units from Central to East',
            version=1,
            created_by_id=self.analyst.id
        )
        db.session.add(self.plan)
        db.session.commit()

        action = RecoveryAction(
            recovery_plan_id=self.plan.id,
            action_sequence=1,
            action_type='DISPATCH_TRANSFER',
            description='Pick and dispatch 40 units of SKU-ROUTER-01 from WH-CENTRAL',
            assigned_to_role='Warehouse Operator',
            cost=320.0,
            status='Pending'
        )
        db.session.add(action)
        db.session.commit()

    # =========================================================================
    # APPROVAL WORKFLOW TESTS
    # =========================================================================

    def test_submit_plan_for_approval_valid_and_role_check(self):
        """Verifies submitting a draft plan moves it to Pending Approval."""
        success, msg = submit_plan_for_approval(self.plan.id, self.analyst)
        self.assertTrue(success)
        self.assertEqual(self.plan.status, 'Pending Approval')

        # Check approval record created
        apprv = Approval.query.filter_by(recovery_plan_id=self.plan.id).first()
        self.assertIsNotNone(apprv)
        self.assertEqual(apprv.status, 'Pending')
        self.assertEqual(apprv.requester_id, self.analyst.id)

    def test_separation_of_duties_prevents_self_approval(self):
        """Verifies that plan creator cannot approve their own plan (separation of duties)."""
        # Set creator to manager, submit plan
        self.plan.created_by_id = self.manager.id
        self.plan.status = 'Pending Approval'
        apprv = Approval(recovery_plan_id=self.plan.id, requester_id=self.manager.id, status='Pending')
        db.session.add(apprv)
        db.session.commit()

        # Manager tries to approve their own plan -> must be rejected
        success, msg = review_plan_approval(self.plan.id, self.manager, 'Approved', 'Self approval')
        self.assertFalse(success)
        self.assertIn('Separation of duties', msg)
        self.assertEqual(self.plan.status, 'Pending Approval')

    def test_approval_decision_flow_and_version_snapshot(self):
        """Verifies approving a plan records decision, sets approval_version, and marks plan Approved."""
        self.plan.status = 'Pending Approval'
        apprv = Approval(recovery_plan_id=self.plan.id, requester_id=self.analyst.id, status='Pending')
        db.session.add(apprv)
        db.session.commit()

        success, msg = review_plan_approval(self.plan.id, self.approver, 'Approved', 'Financial spend authorized')
        self.assertTrue(success)
        self.assertEqual(self.plan.status, 'Approved')
        self.assertEqual(self.plan.approval_version, 1)
        self.assertTrue(self.plan.is_approval_valid())

        # Check approval record updated
        self.assertEqual(apprv.status, 'Approved')
        self.assertEqual(apprv.approver_id, self.approver.id)

    def test_rejection_requires_mandatory_justification(self):
        """Verifies rejecting a plan without comments is rejected with validation error."""
        self.plan.status = 'Pending Approval'
        apprv = Approval(recovery_plan_id=self.plan.id, requester_id=self.analyst.id, status='Pending')
        db.session.add(apprv)
        db.session.commit()

        # Empty comment fails
        success, msg = review_plan_approval(self.plan.id, self.approver, 'Rejected', '   ')
        self.assertFalse(success)
        self.assertIn('mandatory', msg.lower())
        self.assertEqual(self.plan.status, 'Pending Approval')

        # Valid comment succeeds
        success2, msg2 = review_plan_approval(self.plan.id, self.approver, 'Rejected', 'Budget ceiling reached')
        self.assertTrue(success2)
        self.assertEqual(self.plan.status, 'Rejected')
        self.assertEqual(apprv.status, 'Rejected')

    def test_plan_modification_invalidates_prior_approval(self):
        """Verifies modifying an approved plan resets status to Draft, bumps version, and invalidates approval."""
        self.plan.status = 'Approved'
        self.plan.version = 1
        self.plan.approval_version = 1
        db.session.commit()
        self.assertTrue(self.plan.is_approval_valid())

        # Modify plan quantity
        update_data = {'quantity': 35, 'title': 'Updated Transfer to 35 units'}
        success, msg = modify_recovery_plan(self.plan.id, self.manager, update_data)
        self.assertTrue(success)
        self.assertEqual(self.plan.status, 'Draft')
        self.assertEqual(self.plan.version, 2)
        self.assertIsNone(self.plan.approval_version)
        self.assertFalse(self.plan.is_approval_valid())
        self.assertIn('invalidated', msg.lower())

    # =========================================================================
    # SIMULATED EXECUTION TESTS
    # =========================================================================

    def test_execution_blocked_before_approval(self):
        """Verifies executing a draft or pending plan is blocked."""
        key = f"IDEM-{uuid.uuid4().hex[:12]}"
        success, msg, _ = execute_simulated_recovery_plan(self.plan.id, self.warehouse, key, execution_confirmation=True)
        self.assertFalse(success)
        self.assertIn('Only Approved plans can be executed', msg)
        self.assertEqual(self.plan.status, 'Draft')

    def test_execution_blocked_without_explicit_confirmation(self):
        """Verifies execution fails if operator did not check explicit confirmation box."""
        self.plan.status = 'Approved'
        self.plan.approval_version = 1
        db.session.commit()

        key = f"IDEM-{uuid.uuid4().hex[:12]}"
        success, msg, _ = execute_simulated_recovery_plan(self.plan.id, self.warehouse, key, execution_confirmation=False)
        self.assertFalse(success)
        self.assertIn('Explicit execution confirmation is required', msg)

    def test_execution_blocked_if_plan_modified_after_approval(self):
        """Verifies execution is blocked when plan approval version is out of sync."""
        self.plan.status = 'Approved'
        self.plan.version = 2
        self.plan.approval_version = 1  # Stale approval!
        db.session.commit()

        key = f"IDEM-{uuid.uuid4().hex[:12]}"
        success, msg, _ = execute_simulated_recovery_plan(self.plan.id, self.warehouse, key, execution_confirmation=True)
        self.assertFalse(success)
        self.assertIn('Plan approval invalid', msg)

    def test_execution_blocked_when_inventory_becomes_insufficient(self):
        """Verifies execution fails safely if source inventory was depleted before execution."""
        self.plan.status = 'Approved'
        self.plan.version = 1
        self.plan.approval_version = 1
        # Deplete central inventory to only 20 units (below required 40)
        self.inv_central.quantity = 20
        self.inv_central.reserved_quantity = 0
        db.session.commit()

        key = f"IDEM-{uuid.uuid4().hex[:12]}"
        success, msg, _ = execute_simulated_recovery_plan(self.plan.id, self.warehouse, key, execution_confirmation=True)
        self.assertFalse(success)
        self.assertIn('Insufficient available stock', msg)
        self.assertEqual(self.plan.status, 'Approved')

    def test_valid_approved_stock_transfer_and_atomic_balance_updates(self):
        """Verifies successful simulated execution decrements source, increments destination, and updates order."""
        self.plan.status = 'Approved'
        self.plan.version = 1
        self.plan.approval_version = 1
        db.session.commit()

        src_initial_qty = self.inv_central.quantity  # 120
        dest_initial_qty = self.inv_east.quantity     # 10

        key = f"IDEM-{uuid.uuid4().hex[:12]}"
        success, msg, _ = execute_simulated_recovery_plan(self.plan.id, self.warehouse, key, execution_confirmation=True)
        self.assertTrue(success)
        self.assertEqual(self.plan.status, 'Executed')
        self.assertEqual(self.plan.executed_by_id, self.warehouse.id)
        self.assertIsNotNone(self.plan.executed_at)
        self.assertEqual(self.plan.execution_idempotency_key, key)

        # Verify atomic stock balance updates
        db.session.refresh(self.inv_central)
        db.session.refresh(self.inv_east)
        self.assertEqual(self.inv_central.quantity, src_initial_qty - 40)  # 120 - 40 = 80
        self.assertEqual(self.inv_east.quantity, dest_initial_qty + 40)     # 10 + 40 = 50

        # Verify order reallocation
        db.session.refresh(self.order)
        self.assertEqual(self.order.status, 'Allocated')

        # Verify recovery action completed
        action = self.plan.actions.first()
        self.assertEqual(action.status, 'Completed')

    def test_duplicate_execution_prevention_idempotency(self):
        """Verifies that repeating an execution request with the same idempotency key fails without duplicating stock movements."""
        self.plan.status = 'Approved'
        self.plan.version = 1
        self.plan.approval_version = 1
        db.session.commit()

        key = f"IDEM-{uuid.uuid4().hex[:12]}"
        # First execution succeeds
        success1, msg1, _ = execute_simulated_recovery_plan(self.plan.id, self.warehouse, key, execution_confirmation=True)
        self.assertTrue(success1)
        self.assertEqual(self.inv_central.quantity, 80)

        # Duplicate attempt with same key fails safely
        success2, msg2, _ = execute_simulated_recovery_plan(self.plan.id, self.warehouse, key, execution_confirmation=True)
        self.assertFalse(success2)
        self.assertIn('already been executed', msg2)

        # Stock balance remains unchanged (not subtracted twice)
        db.session.refresh(self.inv_central)
        self.assertEqual(self.inv_central.quantity, 80)

    # =========================================================================
    # AUDIT TRAIL & NOTIFICATIONS TESTS
    # =========================================================================

    def test_audit_logs_and_notifications_created_on_workflow_events(self):
        """Verifies audit entries and in-app notifications are emitted at each stage."""
        # 1. Submission
        submit_plan_for_approval(self.plan.id, self.analyst)
        sub_audit = AuditLog.query.filter_by(entity_type='RecoveryPlan', action='SUBMIT_FOR_APPROVAL').first()
        self.assertIsNotNone(sub_audit)
        self.assertEqual(sub_audit.user_id, self.analyst.id)

        # Notification for approver
        apprv_notif = Notification.query.filter(Notification.recipient_role.in_([Role.PROCUREMENT_APPROVER, Role.SUPPLY_CHAIN_MANAGER])).first()
        self.assertIsNotNone(apprv_notif)

        # 2. Approval
        review_plan_approval(self.plan.id, self.approver, 'Approved', 'Approved by test')
        apprv_audit = AuditLog.query.filter_by(entity_type='RecoveryPlan', action='APPROVE_PLAN').first()
        self.assertIsNotNone(apprv_audit)
        self.assertEqual(apprv_audit.user_id, self.approver.id)

        # 3. Execution
        key = f"IDEM-{uuid.uuid4().hex[:12]}"
        execute_simulated_recovery_plan(self.plan.id, self.warehouse, key, execution_confirmation=True)
        exec_audit = AuditLog.query.filter_by(entity_type='RecoveryPlan', action='EXECUTE_RECOVERY_PLAN').first()
        self.assertIsNotNone(exec_audit)
        self.assertEqual(exec_audit.user_id, self.warehouse.id)

    # =========================================================================
    # ROLE-BASED HTTP ROUTE PROTECTION
    # =========================================================================

    def test_role_based_http_access_restrictions(self):
        """Verifies HTTP 403 access control across all roles for recovery routes."""
        # Operations Analyst cannot access approvals queue (HTTP 403)
        self.login('analyst', 'DisruptionIQ@2026!')
        resp = self.client.get('/approvals')
        self.assertEqual(resp.status_code, 403)

        # Operations Analyst cannot approve plans (HTTP 403)
        resp2 = self.client.post(f'/recovery-plans/{self.plan.id}/decision', data={'decision': 'Approved'})
        self.assertEqual(resp2.status_code, 403)
        self.logout()

        # Procurement Approver cannot execute warehouse transfers (HTTP 403)
        self.login('approver', 'DisruptionIQ@2026!')
        resp3 = self.client.get(f'/recovery-plans/{self.plan.id}/confirm-execution')
        self.assertEqual(resp3.status_code, 403)
        self.logout()

        # Warehouse Operator can access confirmation screen for approved plan (HTTP 200)
        self.plan.status = 'Approved'
        self.plan.version = 1
        self.plan.approval_version = 1
        db.session.commit()

        self.login('warehouse', 'DisruptionIQ@2026!')
        resp4 = self.client.get(f'/recovery-plans/{self.plan.id}/confirm-execution')
        self.assertEqual(resp4.status_code, 200)
        self.assertIn(b'Simulated Execution Confirmation', resp4.data)


if __name__ == '__main__':
    unittest.main()
