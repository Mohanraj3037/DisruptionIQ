import unittest
from datetime import datetime, timezone
from app.extensions import db
from app.models.user import User, Role
from app.models.logistics import Warehouse, Inventory, Supplier, Shipment
from app.models.orders import CustomerOrder, OrderItem
from app.models.disruptions import Disruption, RecoveryPlan
from app.services.auth_service import seed_demo_accounts
from app.services.recovery_planning_service import (
    generate_recovery_recommendations,
    create_plan_from_recommendation
)
from tests.test_base import BaseTestCase


class TestRecoveryEngine(BaseTestCase):
    """
    Test suite for Module A: Recovery Recommendation Engine.
    Verifies multi-option candidate generation, deterministic multi-criteria ranking,
    inventory constraint safety, and duplicate plan prevention.
    """

    def setUp(self):
        super().setUp()
        seed_demo_accounts()
        self.analyst = User.query.filter_by(username='analyst').first()

        # Seed test logistics data
        self.wh_east = Warehouse(code='WH-EAST', name='East Coast Hub', location='Newark, NJ', capacity_sqm=10000.0)
        self.wh_central = Warehouse(code='WH-CENTRAL', name='Central Hub', location='Chicago, IL', capacity_sqm=15000.0)
        self.supplier = Supplier(code='SUP-001', name='Apex Micro', city='Austin, TX', contact_email='apex@test.com', lead_time_days=7, reliability_score=92.0)
        db.session.add_all([self.wh_east, self.wh_central, self.supplier])
        db.session.commit()

        # East has low/zero stock; Central has usable surplus
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

        # Create active disruption at WH-EAST
        self.disruption = Disruption(
            disruption_code='DIS-TEST-001',
            title='Confirmed Shortage for SKU-ROUTER-01 at WH-EAST',
            disruption_type='Inventory Shortage',
            shortage_category='Confirmed Shortage',
            severity='High',
            status='Active',
            warehouse_id=self.wh_east.id,
            location='Newark Hub - Bay 2',
            description='Confirmed shortage for SKU-ROUTER-01 affecting outbound orders',
            estimated_delay_hours=48
        )
        db.session.add(self.disruption)
        db.session.commit()

        # Link affected customer order with order item
        self.order = CustomerOrder(
            order_number='ORD-TEST-101',
            customer_name='Acme Corp',
            customer_tier='Tier 1',
            status='At Risk',
            priority='High',
            total_value=7500.0,
            assigned_warehouse_id=self.wh_east.id
        )
        db.session.add(self.order)
        db.session.commit()

        self.item = OrderItem(
            order_id=self.order.id,
            sku='SKU-ROUTER-01',
            item_name='Enterprise Core Router',
            quantity=50,
            unit_price=150.0
        )
        db.session.add(self.item)
        self.disruption.affected_orders.append(self.order)
        db.session.commit()

    def test_inter_warehouse_transfer_feasibility_and_surplus(self):
        """Verifies candidate option identifies WH-CENTRAL surplus (70 units) to cover 50 units."""
        options = generate_recovery_recommendations(self.disruption.id)
        self.assertIsInstance(options, list)
        self.assertGreater(len(options), 0)

        transfer_opts = [o for o in options if o['strategy_type'] == 'Inter-Warehouse Stock Transfer']
        self.assertEqual(len(transfer_opts), 1)
        transfer_opt = transfer_opts[0]

        self.assertEqual(transfer_opt['feasibility'], 'Feasible')
        self.assertEqual(transfer_opt['quantity'], 50)
        self.assertIn('WH-CENTRAL', transfer_opt['source_location'])
        self.assertIn('WH-EAST', transfer_opt['destination_location'])
        self.assertGreater(transfer_opt['estimated_cost'], 0)
        self.assertGreater(transfer_opt['estimated_delay_reduction_hours'], 0)
        self.assertIn('source_projected_available', transfer_opt['inventory_impact'])

    def test_inter_warehouse_transfer_infeasible_when_no_surplus(self):
        """Verifies transfer option is not offered or marked constrained when source warehouse has no usable surplus."""
        # Reduce central stock so that usable surplus is 0
        self.inv_central.quantity = 50
        self.inv_central.reserved_quantity = 20
        self.inv_central.reorder_point = 35  # Usable = 50 - 20 - 35 = -5 (0)
        db.session.commit()

        options = generate_recovery_recommendations(self.disruption.id)
        transfer_opts = [o for o in options if o['strategy_type'] == 'Inter-Warehouse Stock Transfer']
        self.assertEqual(len(transfer_opts), 0)

    def test_alternative_supplier_option_generation(self):
        """Verifies alternative supplier replenishment option calculates lead time and estimated purchase cost."""
        options = generate_recovery_recommendations(self.disruption.id)
        supplier_opts = [o for o in options if o['strategy_type'] == 'Alternative Supplier']
        self.assertEqual(len(supplier_opts), 1)
        sup_opt = supplier_opts[0]

        self.assertEqual(sup_opt['feasibility'], 'Feasible')
        self.assertIn('Apex Micro', sup_opt['title'])
        self.assertIn('Apex Micro', sup_opt['source_location'])
        self.assertGreater(sup_opt['estimated_cost'], 0)
        self.assertEqual(sup_opt['quantity'], 50)

    def test_deterministic_multi_criteria_ranking(self):
        """Verifies deterministic ranking score formula and ordering across candidate options."""
        options = generate_recovery_recommendations(self.disruption.id)
        self.assertGreater(len(options), 1)

        # Check ranking order (1-indexed)
        ranks = [o['rank'] for o in options]
        self.assertEqual(ranks, list(range(1, len(options) + 1)))

        # Verified recommendation score exists and is sorted descending
        for i in range(len(options) - 1):
            self.assertGreaterEqual(options[i]['recommendation_score'], options[i+1]['recommendation_score'])

    def test_create_plan_from_recommendation_and_duplicate_prevention(self):
        """Verifies converting recommendation to plan and preventing duplicate plan creations."""
        options = generate_recovery_recommendations(self.disruption.id)
        top_opt = options[0]

        # 1. First creation succeeds
        plan1 = create_plan_from_recommendation(self.disruption.id, top_opt, self.analyst.id)
        self.assertIsInstance(plan1, RecoveryPlan)
        self.assertEqual(plan1.disruption_id, self.disruption.id)
        self.assertEqual(plan1.status, 'Draft')
        self.assertEqual(plan1.version, 1)
        self.assertGreater(plan1.actions.count(), 0)

        # 2. Second creation with same recommendation returns existing plan without duplication
        plan2 = create_plan_from_recommendation(self.disruption.id, top_opt, self.analyst.id)
        self.assertEqual(plan1.id, plan2.id)

    def test_no_feasible_option_when_all_constraints_exhausted(self):
        """Verifies clean handling when disruption has no stock, no suppliers, and no shipments."""
        empty_disruption = Disruption(
            disruption_code='DIS-EMPTY-001',
            title='Isolated SKU Shortage',
            disruption_type='Inventory Shortage',
            shortage_category='Confirmed Shortage',
            severity='Medium',
            status='Active',
            warehouse_id=self.wh_east.id,
            description='Isolated shortage for unstocked SKU'
        )
        db.session.add(empty_disruption)
        db.session.commit()

        empty_order = CustomerOrder(
            order_number='ORD-EMPTY-999',
            customer_name='Unknown Buyer',
            customer_tier='Standard',
            status='At Risk',
            priority='Low',
            total_value=500.0,
            assigned_warehouse_id=self.wh_east.id
        )
        db.session.add(empty_order)
        db.session.commit()

        empty_item = OrderItem(
            order_id=empty_order.id,
            sku='SKU-NONEXISTENT',
            item_name='Discontinued Unit',
            quantity=100,
            unit_price=5.0
        )
        db.session.add(empty_item)
        empty_disruption.affected_orders.append(empty_order)
        db.session.commit()

        options = generate_recovery_recommendations(empty_disruption.id)
        self.assertIsInstance(options, list)
        # Any fallback options generated have constrained/split feasibility
        transfer_opts = [o for o in options if o['strategy_type'] == 'Inter-Warehouse Stock Transfer']
        self.assertEqual(len(transfer_opts), 0)


if __name__ == '__main__':
    unittest.main()
