import unittest
from datetime import datetime, timezone
from tests.test_base import BaseTestCase
from app.extensions import db
from app.services.auth_service import seed_demo_accounts
from app.services.seed_service import seed_logistics_data
from app.services.disruption_service import (
    evaluate_and_record_shipment_disruption,
    detect_warehouse_inventory_shortages,
    run_full_disruption_scan
)
from app.models.logistics import Shipment, Warehouse, Inventory
from app.models.orders import CustomerOrder
from app.models.disruptions import Disruption


class TestDisruptions(BaseTestCase):

    def setUp(self):
        super().setUp()
        seed_demo_accounts()
        seed_logistics_data()

    def test_distinguish_confirmed_vs_potential_shortage(self):
        """
        Verifies that:
        1. A delayed shipment is classified as 'Potential Shortage' when stock is en route but delayed.
        2. A warehouse with zero or insufficient on-hand available inventory for allocated orders is classified as 'Confirmed Shortage'.
        """
        # Scenario A is Potential Shortage
        dis_a = Disruption.query.filter_by(disruption_code='DIS-2026-001').first()
        self.assertIsNotNone(dis_a)
        self.assertEqual(dis_a.shortage_category, 'Potential Shortage')
        self.assertIsNotNone(dis_a.shipment_id)

        # Scenario B is Confirmed Shortage
        dis_b = Disruption.query.filter_by(disruption_code='DIS-2026-002').first()
        self.assertIsNotNone(dis_b)
        self.assertEqual(dis_b.shortage_category, 'Confirmed Shortage')
        self.assertIsNotNone(dis_b.warehouse_id)

    def test_evaluate_shipment_disruption_links_orders(self):
        """Verifies evaluating a delayed shipment links customer orders requesting the delayed SKUs at that warehouse."""
        shp = Shipment.query.filter_by(tracking_number='SHP-2026-001').first()
        self.assertIsNotNone(shp)

        # Trigger 48h delay
        dis = evaluate_and_record_shipment_disruption(
            shipment=shp,
            delay_hours=48,
            reason='Typhoon warning in South China Sea.'
        )

        self.assertIsNotNone(dis)
        self.assertEqual(dis.status, 'Active')
        self.assertEqual(dis.shortage_category, 'Potential Shortage')
        self.assertEqual(dis.estimated_delay_hours, 48)

        # Verify affected orders are marked 'At Risk'
        affected = dis.affected_orders.all()
        for ord in affected:
            self.assertEqual(ord.status, 'At Risk')

    def test_detect_warehouse_inventory_shortages(self):
        """Verifies inventory shortage scanner detects deficits and returns structured shortage records."""
        shortages = detect_warehouse_inventory_shortages()
        self.assertIsInstance(shortages, list)
        self.assertGreaterEqual(len(shortages), 1)

        # Check that WH-EAST SKU-SNS-02 is among shortages
        east_shortage = next(
            (s for s in shortages if s.warehouse and s.warehouse.code == 'WH-EAST' and 'SKU-SNS-02' in s.disruption_code),
            None
        )
        self.assertIsNotNone(east_shortage)
        self.assertEqual(east_shortage.shortage_category, 'Confirmed Shortage')
        self.assertIn('ORD-2026-012', [o.order_number for o in east_shortage.affected_orders.all()])

    def test_run_full_disruption_scan(self):
        """Verifies full scan executes both transit and inventory checks without errors."""
        res = run_full_disruption_scan()
        self.assertIn('delayed_shipments_evaluated', res)
        self.assertIn('warehouse_shortages_evaluated', res)
        self.assertIn('active_disruptions_count', res)


if __name__ == '__main__':
    unittest.main()
