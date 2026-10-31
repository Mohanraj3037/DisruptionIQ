import unittest
from sqlalchemy.exc import IntegrityError
from app.extensions import db
from app.models.user import User, Role
from app.models.logistics import Supplier, Warehouse, Inventory, Shipment
from app.models.orders import CustomerOrder, OrderItem
from app.models.disruptions import Disruption, RecoveryPlan, RecoveryAction
from app.models.governance import Approval, AuditLog, WebhookEvent, Notification
from tests.test_base import BaseTestCase


class TestModels(BaseTestCase):

    def test_user_password_hashing(self):
        user = User(username='testops', email='ops@disruptioniq.local', role=Role.OPERATIONS_ANALYST)
        user.set_password('SecretPass123!')
        db.session.add(user)
        db.session.commit()

        # Verify password is not stored plaintext
        self.assertNotEqual(user.password_hash, 'SecretPass123!')
        self.assertTrue(user.check_password('SecretPass123!'))
        self.assertFalse(user.check_password('WrongPass'))

    def test_user_role_methods(self):
        admin = User(username='adm', email='adm@disruptioniq.local', role=Role.ADMINISTRATOR)
        analyst = User(username='anl', email='anl@disruptioniq.local', role=Role.OPERATIONS_ANALYST)
        
        # Admin has all permissions
        self.assertTrue(admin.has_role(Role.PROCUREMENT_APPROVER))
        self.assertTrue(admin.has_role(Role.OPERATIONS_ANALYST))

        # Analyst has analyst permission, but not procurement approver
        self.assertTrue(analyst.has_role(Role.OPERATIONS_ANALYST))
        self.assertFalse(analyst.has_role(Role.PROCUREMENT_APPROVER))

    def test_inventory_non_negative_constraint(self):
        wh = Warehouse(code='WH-TEST-01', name='Test Warehouse')
        db.session.add(wh)
        db.session.commit()

        # Valid inventory item
        item = Inventory(
            warehouse_id=wh.id,
            sku='SKU-VALID',
            item_name='Semiconductor Microcontroller',
            quantity=50,
            reserved_quantity=10,
            reorder_point=15,
            unit_cost=25.0
        )
        db.session.add(item)
        db.session.commit()
        self.assertEqual(item.available_quantity, 40)
        self.assertFalse(item.is_low_stock)

        # Invalid negative inventory should trigger IntegrityError
        invalid_item = Inventory(
            warehouse_id=wh.id,
            sku='SKU-INVALID-NEG',
            item_name='Negative Stock Item',
            quantity=-5,
            reserved_quantity=0
        )
        db.session.add(invalid_item)
        with self.assertRaises(IntegrityError):
            db.session.commit()
        db.session.rollback()

    def test_webhook_event_unique_identifier_constraint(self):
        evt1 = WebhookEvent(
            event_identifier='EVT-MAERSK-2026-001',
            source='CarrierAPI',
            event_type='PORT_CONGESTION',
            payload_json='{"port": "SGSIN"}'
        )
        db.session.add(evt1)
        db.session.commit()

        # Duplicate event identifier must be rejected
        evt2 = WebhookEvent(
            event_identifier='EVT-MAERSK-2026-001',
            source='CarrierAPI_Duplicate',
            event_type='PORT_CONGESTION',
            payload_json='{"port": "SGSIN"}'
        )
        db.session.add(evt2)
        with self.assertRaises(IntegrityError):
            db.session.commit()
        db.session.rollback()

    def test_disruption_and_recovery_plan_relationship(self):
        disruption = Disruption(
            disruption_code='DIS-TEST-01',
            title='Typhoon Near Shanghai Port',
            disruption_type='Severe Weather',
            severity='Critical',
            estimated_delay_hours=72
        )
        db.session.add(disruption)
        db.session.commit()

        plan = RecoveryPlan(
            plan_code='PLAN-REC-01',
            disruption_id=disruption.id,
            title='Reroute to Ningbo Port',
            strategy_type='Reroute Port',
            estimated_cost=15000.0,
            estimated_delay_reduction_hours=48
        )
        db.session.add(plan)
        db.session.commit()

        self.assertEqual(disruption.recovery_plans.count(), 1)
        self.assertEqual(disruption.recovery_plans.first().plan_code, 'PLAN-REC-01')


if __name__ == '__main__':
    unittest.main()
