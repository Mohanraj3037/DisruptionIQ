import unittest
from tests.test_base import BaseTestCase
from app.services.auth_service import seed_demo_accounts
from app.services.seed_service import seed_logistics_data
from app.models.logistics import Supplier, Warehouse, Inventory, Shipment, ShipmentItem
from app.models.orders import CustomerOrder
from app.models.disruptions import Disruption


class TestSeedData(BaseTestCase):

    def setUp(self):
        super().setUp()
        seed_demo_accounts()

    def test_seed_creates_expected_entities(self):
        """Verifies synthetic demo data seeds exactly the specified entities and links."""
        res = seed_logistics_data()
        
        # 5 suppliers
        self.assertEqual(Supplier.query.count(), 5)
        # 3 warehouses
        self.assertEqual(Warehouse.query.count(), 3)
        # 10 SKUs (distinct SKUs across inventories)
        distinct_skus = {inv.sku for inv in Inventory.query.all()}
        self.assertEqual(len(distinct_skus), 10)
        # 12 shipments
        self.assertEqual(Shipment.query.count(), 12)
        # 25 customer orders
        self.assertEqual(CustomerOrder.query.count(), 25)
        # Disruptions
        self.assertGreaterEqual(Disruption.query.count(), 2)

    def test_seed_repeatability_and_idempotency(self):
        """Verifies seed script does not reset or duplicate records when run repeatedly."""
        res1 = seed_logistics_data()
        count_suppliers_1 = Supplier.query.count()
        count_shipments_1 = Shipment.query.count()
        count_orders_1 = CustomerOrder.query.count()
        count_disruptions_1 = Disruption.query.count()

        # Run second time
        res2 = seed_logistics_data()
        count_suppliers_2 = Supplier.query.count()
        count_shipments_2 = Shipment.query.count()
        count_orders_2 = CustomerOrder.query.count()
        count_disruptions_2 = Disruption.query.count()

        self.assertEqual(count_suppliers_1, count_suppliers_2)
        self.assertEqual(count_shipments_1, count_shipments_2)
        self.assertEqual(count_orders_1, count_orders_2)
        self.assertEqual(count_disruptions_1, count_disruptions_2)

    def test_scenario_a_delayed_shipment(self):
        """Verifies Scenario A: delayed shipment SHP-2026-003 causes Potential Shortage affecting multiple orders."""
        seed_logistics_data()

        shipment = Shipment.query.filter_by(tracking_number='SHP-2026-003').first()
        self.assertIsNotNone(shipment)
        self.assertEqual(shipment.status, 'Delayed')
        self.assertEqual(shipment.destination_warehouse.code, 'WH-WEST')

        # Cargo verification
        items = shipment.items
        self.assertTrue(any(it.sku == 'SKU-MCU-01' and it.quantity == 500 for it in items))

        # Disruption verification
        disruption = Disruption.query.filter_by(disruption_code='DIS-2026-001').first()
        self.assertIsNotNone(disruption)
        self.assertEqual(disruption.shortage_category, 'Potential Shortage')
        self.assertEqual(disruption.severity, 'Critical')
        self.assertEqual(disruption.shipment_id, shipment.id)

        # Affected customer orders
        affected_order_numbers = {o.order_number for o in disruption.affected_orders.all()}
        self.assertIn('ORD-2026-004', affected_order_numbers)
        self.assertIn('ORD-2026-007', affected_order_numbers)
        self.assertIn('ORD-2026-015', affected_order_numbers)

        for ord_num in affected_order_numbers:
            co = CustomerOrder.query.filter_by(order_number=ord_num).first()
            self.assertEqual(co.status, 'At Risk')

    def test_scenario_b_warehouse_shortage(self):
        """Verifies Scenario B: Confirmed Shortage at WH-EAST with surplus at WH-CENTRAL."""
        seed_logistics_data()

        wh_east = Warehouse.query.filter_by(code='WH-EAST').first()
        wh_central = Warehouse.query.filter_by(code='WH-CENTRAL').first()
        self.assertIsNotNone(wh_east)
        self.assertIsNotNone(wh_central)

        # Stock at WH-EAST for SKU-SNS-02
        inv_east = Inventory.query.filter_by(warehouse_id=wh_east.id, sku='SKU-SNS-02').first()
        self.assertIsNotNone(inv_east)
        self.assertEqual(inv_east.quantity, 20)
        self.assertEqual(inv_east.reserved_quantity, 15)
        self.assertEqual(inv_east.available_quantity, 5)

        # Stock at WH-CENTRAL has surplus
        inv_central = Inventory.query.filter_by(warehouse_id=wh_central.id, sku='SKU-SNS-02').first()
        self.assertIsNotNone(inv_central)
        self.assertGreater(inv_central.available_quantity, 120)

        # Disruption verification
        disruption = Disruption.query.filter_by(disruption_code='DIS-2026-002').first()
        self.assertIsNotNone(disruption)
        self.assertEqual(disruption.shortage_category, 'Confirmed Shortage')
        self.assertEqual(disruption.severity, 'High')
        self.assertEqual(disruption.warehouse_id, wh_east.id)

        # Affected order ORD-2026-012
        affected_orders = [o.order_number for o in disruption.affected_orders.all()]
        self.assertIn('ORD-2026-012', affected_orders)


if __name__ == '__main__':
    unittest.main()
