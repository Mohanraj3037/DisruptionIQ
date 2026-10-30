import unittest
from datetime import datetime, timezone, timedelta
from tests.test_base import BaseTestCase
from app.extensions import db
from app.models.logistics import Supplier, Warehouse, Inventory, Shipment, ShipmentItem
from app.models.orders import CustomerOrder, OrderItem
from app.models.disruptions import Disruption
from app.services.risk_scoring_service import (
    calculate_order_risk,
    calculate_deadline_risk,
    calculate_shortage_risk,
    calculate_customer_priority_risk,
    calculate_recovery_difficulty_risk,
    classify_severity,
    score_and_rank_all_affected_orders,
    RISK_SCORING_CONFIG
)
from app.services.impact_analysis_service import analyze_disruption_impact


class TestRiskEngine(BaseTestCase):
    """Unit and integration tests for the deterministic risk scoring and impact analysis engine."""

    def setUp(self):
        super().setUp()
        self.now = datetime.now(timezone.utc)

        # 1. Setup Suppliers
        self.sup = Supplier(
            code='SUP-TEST',
            name='Test Tech Foundry',
            country='Taiwan',
            lead_time_days=14,
            reliability_score=0.95
        )
        db.session.add(self.sup)

        # 2. Setup Warehouses
        self.wh_dest = Warehouse(code='WH-DEST', name='Destination Hub', location='Frankfurt')
        self.wh_alt = Warehouse(code='WH-ALT', name='Alternative Hub', location='Rotterdam')
        db.session.add_all([self.wh_dest, self.wh_alt])
        db.session.flush()

        # 3. Setup Inventory at Destination (Low stock on SKU-ALPHA)
        self.inv_dest = Inventory(
            warehouse_id=self.wh_dest.id,
            sku='SKU-ALPHA',
            item_name='Microcontroller Unit',
            quantity=30,
            reserved_quantity=20,  # Available: 10
            reorder_point=25,
            unit_cost=15.0
        )
        # Setup Inventory at Alt Warehouse (Surplus stock on SKU-ALPHA)
        self.inv_alt = Inventory(
            warehouse_id=self.wh_alt.id,
            sku='SKU-ALPHA',
            item_name='Microcontroller Unit',
            quantity=200,
            reserved_quantity=20,  # Available: 180, Reorder: 30 -> Surplus: 150
            reorder_point=30,
            unit_cost=15.0
        )
        db.session.add_all([self.inv_dest, self.inv_alt])

        # 4. Setup Delayed Shipment
        self.shipment = Shipment(
            tracking_number='SHP-TEST-001',
            supplier_id=self.sup.id,
            destination_warehouse_id=self.wh_dest.id,
            carrier='CargoLink Sea',
            status='Delayed',
            estimated_arrival=self.now + timedelta(days=3)
        )
        db.session.add(self.shipment)
        db.session.flush()

        self.shp_item = ShipmentItem(
            shipment_id=self.shipment.id,
            sku='SKU-ALPHA',
            item_name='Microcontroller Unit',
            quantity=100
        )
        db.session.add(self.shp_item)

        # 5. Setup Disruption
        self.disruption = Disruption(
            disruption_code='DIS-TEST-001',
            title='Port Congestion Delay',
            disruption_type='Port Congestion',
            severity='High',
            status='Active',
            shortage_category='Potential Shortage',
            shipment_id=self.shipment.id,
            warehouse_id=self.wh_dest.id,
            estimated_delay_hours=72,
            detected_at=self.now
        )
        db.session.add(self.disruption)
        db.session.flush()

        # 6. Setup Customer Order
        self.order = CustomerOrder(
            order_number='ORD-TEST-001',
            customer_name='Acme Robotics Corp',
            customer_tier='Platinum',
            priority='Critical',
            status='At Risk',
            assigned_warehouse_id=self.wh_dest.id,
            order_date=self.now - timedelta(days=2),
            delivery_deadline=self.now + timedelta(hours=48),  # 48h deadline vs 72h delay!
            total_value=1500.0
        )
        db.session.add(self.order)
        db.session.flush()

        self.ord_item = OrderItem(
            order_id=self.order.id,
            sku='SKU-ALPHA',
            item_name='Microcontroller Unit',
            quantity=50,  # 50 required vs 10 available
            unit_price=30.0
        )
        db.session.add(self.ord_item)

        # Link order to disruption
        self.disruption.affected_orders.append(self.order)
        db.session.commit()

    def test_risk_score_formula_exact_result(self):
        """Verifies exact weighted formula: 0.35*D + 0.30*S + 0.20*P + 0.15*R."""
        result = calculate_order_risk(self.order, self.disruption, ['SKU-ALPHA'], self.now)

        comps = result['components']
        d_score = comps['deadline_risk']['score']
        s_score = comps['shortage_risk']['score']
        p_score = comps['customer_priority']['score']
        r_score = comps['recovery_difficulty']['score']

        expected = round(0.35 * d_score + 0.30 * s_score + 0.20 * p_score + 0.15 * r_score, 2)
        self.assertEqual(result['final_risk_score'], expected)

    def test_risk_score_bounds_between_zero_and_hundred(self):
        """Verifies calculated risk scores strictly remain within [0.00, 100.00]."""
        result = calculate_order_risk(self.order, self.disruption, ['SKU-ALPHA'], self.now)
        self.assertGreaterEqual(result['final_risk_score'], 0.0)
        self.assertLessEqual(result['final_risk_score'], 100.0)

    def test_severity_boundaries(self):
        """Verifies precise classification across Critical, High, Medium, Low severity bands."""
        self.assertEqual(classify_severity(100.00), 'Critical')
        self.assertEqual(classify_severity(80.00), 'Critical')
        self.assertEqual(classify_severity(79.99), 'High')
        self.assertEqual(classify_severity(60.00), 'High')
        self.assertEqual(classify_severity(59.99), 'Medium')
        self.assertEqual(classify_severity(30.00), 'Medium')
        self.assertEqual(classify_severity(29.99), 'Low')
        self.assertEqual(classify_severity(0.00), 'Low')

    def test_missing_delivery_deadline_handling(self):
        """Verifies missing delivery deadline assigns baseline uncertainty penalty (50.0) without crashing."""
        self.order.delivery_deadline = None
        db.session.commit()

        d_risk = calculate_deadline_risk(self.order, self.disruption, self.now)
        self.assertEqual(d_risk['score'], 50.0)
        self.assertIn('Missing promised delivery deadline', d_risk['evidence'])

        result = calculate_order_risk(self.order, self.disruption, ['SKU-ALPHA'], self.now)
        self.assertIsNone(result['delivery_deadline'])
        self.assertGreater(result['final_risk_score'], 0.0)

    def test_missing_inventory_handling(self):
        """Verifies unknown / unstocked SKU is treated as full shortage (100.0) without error."""
        self.ord_item.sku = 'SKU-UNKNOWN-999'
        db.session.commit()

        s_risk = calculate_shortage_risk(self.order, self.disruption, ['SKU-UNKNOWN-999'])
        self.assertEqual(s_risk['score'], 100.0)
        self.assertEqual(s_risk['available_quantity'], 0)
        self.assertEqual(s_risk['shortage_quantity'], 50)

    def test_confirmed_vs_potential_shortage_distinction(self):
        """Verifies impact analysis distinguishes confirmed shortage (no supply) from potential shortage (delayed supply)."""
        # 1. Potential Shortage: Inbound shipment is delayed
        impact_a = analyze_disruption_impact(self.disruption.id)
        self.assertIn('Potential Shortage', impact_a['disruption']['shortage_category'])

        # 2. Confirmed Shortage: No inbound shipment exists
        dis_confirmed = Disruption(
            disruption_code='DIS-CONF-001',
            title='Warehouse Stockout',
            disruption_type='Warehouse Stockout',
            severity='High',
            status='Active',
            shortage_category='Confirmed Shortage',
            shipment_id=None,
            warehouse_id=self.wh_dest.id,
            estimated_delay_hours=48,
            detected_at=self.now
        )
        db.session.add(dis_confirmed)
        dis_confirmed.affected_orders.append(self.order)
        db.session.commit()

        impact_b = analyze_disruption_impact(dis_confirmed.id)
        self.assertEqual(impact_b['disruption']['shortage_category'], 'Confirmed Shortage')

    def test_delayed_shipment_not_counted_as_available_stock(self):
        """Verifies delayed cargo is NEVER counted as currently available inventory."""
        self.inv_dest.quantity = 25
        self.inv_dest.reserved_quantity = 25  # Available: 0
        db.session.commit()

        s_risk = calculate_shortage_risk(self.order, self.disruption, ['SKU-ALPHA'])
        # Available stock must remain strictly 0 even though shipment has 100 delayed units
        self.assertEqual(s_risk['available_quantity'], 0)
        self.assertEqual(s_risk['score'], 100.0)

    def test_alternative_warehouse_surplus_and_recovery_feasibility(self):
        """Verifies alternative warehouse surplus is recognized to reduce recovery difficulty."""
        # WH-ALT has 180 available - 30 reorder = 150 surplus units (covers 50 units demanded)
        r_risk = calculate_recovery_difficulty_risk(self.order, self.disruption, 'SKU-ALPHA', 50, self.now)
        self.assertEqual(r_risk['score'], 20.0)
        self.assertIn('WH-ALT', r_risk['transfer_candidate_warehouses'])
        self.assertEqual(r_risk['alternative_surplus_units'], 150)

        # If alternative warehouse has 0 surplus:
        self.inv_alt.quantity = 30
        self.inv_alt.reserved_quantity = 10  # 20 available vs 30 reorder point -> 0 surplus
        db.session.commit()

        r_risk_no_surplus = calculate_recovery_difficulty_risk(self.order, self.disruption, 'SKU-ALPHA', 50, self.now)
        self.assertGreaterEqual(r_risk_no_surplus['score'], 75.0)

    def test_dynamic_recalculation_after_shipment_delay_update(self):
        """Verifies score dynamically recalculates when shipment delay increases."""
        # Initial score with 72h delay
        score_1 = calculate_order_risk(self.order, self.disruption, ['SKU-ALPHA'], self.now)['final_risk_score']

        # Increase delay to 120h
        self.disruption.estimated_delay_hours = 120
        db.session.commit()

        score_2 = calculate_order_risk(self.order, self.disruption, ['SKU-ALPHA'], self.now)['final_risk_score']
        self.assertGreater(score_2, score_1)

    def test_dynamic_recalculation_after_inventory_update(self):
        """Verifies score dynamically recalculates when inventory stock increases."""
        score_before = calculate_order_risk(self.order, self.disruption, ['SKU-ALPHA'], self.now)['final_risk_score']

        # Stock arrived: inventory increased to 500 units available
        self.inv_dest.quantity = 600
        self.inv_dest.reserved_quantity = 100  # 500 available
        db.session.commit()

        score_after = calculate_order_risk(self.order, self.disruption, ['SKU-ALPHA'], self.now)['final_risk_score']
        self.assertLess(score_after, score_before)

    def test_dynamic_recalculation_after_order_priority_change(self):
        """Verifies score dynamically recalculates when order priority is changed."""
        score_critical = calculate_order_risk(self.order, self.disruption, ['SKU-ALPHA'], self.now)['final_risk_score']

        # Downgrade to Low priority
        self.order.priority = 'Low'
        self.order.customer_tier = 'Standard'
        db.session.commit()

        score_low = calculate_order_risk(self.order, self.disruption, ['SKU-ALPHA'], self.now)['final_risk_score']
        self.assertLess(score_low, score_critical)

    def test_deterministic_sorting_and_tie_breaking(self):
        """Verifies deterministic sorting: score DESC, earliest deadline ASC, order_number ASC."""
        # Create a second order with identical score drivers but earlier deadline
        ord_early = CustomerOrder(
            order_number='ORD-AAA-EARLY',
            customer_name='Early Corp',
            customer_tier='Platinum',
            priority='Critical',
            status='At Risk',
            assigned_warehouse_id=self.wh_dest.id,
            order_date=self.now,
            delivery_deadline=self.now + timedelta(hours=24),  # Earlier deadline!
            total_value=500.0
        )
        db.session.add(ord_early)
        db.session.flush()

        item_early = OrderItem(order_id=ord_early.id, sku='SKU-ALPHA', item_name='MCU', quantity=50, unit_price=10.0)
        db.session.add(item_early)
        self.disruption.affected_orders.append(ord_early)
        db.session.commit()

        ranked = score_and_rank_all_affected_orders(disruption_id=self.disruption.id)
        self.assertEqual(len(ranked), 2)
        # Order with earlier deadline and higher SLA pressure ranks #1
        self.assertEqual(ranked[0]['rank'], 1)
        self.assertGreaterEqual(ranked[0]['final_risk_score'], ranked[1]['final_risk_score'])


if __name__ == '__main__':
    unittest.main()
