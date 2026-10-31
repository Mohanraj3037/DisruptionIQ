import unittest
import json
from tests.test_base import BaseTestCase
from app.extensions import db
from app.services.auth_service import seed_demo_accounts
from app.services.seed_service import seed_logistics_data
from app.services.import_service import process_shipments_import, process_inventory_import
from app.models.logistics import Shipment, Inventory, Warehouse, Supplier
from app.models.governance import AuditLog


class TestImports(BaseTestCase):

    def setUp(self):
        super().setUp()
        seed_demo_accounts()
        seed_logistics_data()

    def test_import_shipments_valid_csv(self):
        """Verifies valid CSV shipment import creates shipment and item records and audit log."""
        csv_content = (
            "tracking_number,carrier,transport_mode,status,origin_city,destination_warehouse_code,supplier_code,estimated_departure,estimated_arrival,sku,item_name,quantity\n"
            "SHP-TEST-CSV-01,DHL Global,Air,In Transit,Frankfurt Germany,WH-EAST,SUP-APEX,2026-11-01,2026-11-05,SKU-MCU-01,Cortex-M4 Microcontroller,150\n"
        ).encode('utf-8')

        res = process_shipments_import(csv_content, 'new_shipment.csv', dry_run=False)
        self.assertTrue(res['success'], f"Import failed: {res.get('errors')}")
        self.assertEqual(res['imported'], 1)

        shp = Shipment.query.filter_by(tracking_number='SHP-TEST-CSV-01').first()
        self.assertIsNotNone(shp)
        self.assertEqual(shp.carrier, 'DHL Global')
        self.assertEqual(shp.items.count(), 1)
        first_item = shp.items.first()
        self.assertEqual(first_item.sku, 'SKU-MCU-01')
        self.assertEqual(first_item.quantity, 150)

        # Verify audit log
        log = AuditLog.query.filter_by(action='IMPORT_SHIPMENTS').order_by(AuditLog.id.desc()).first()
        self.assertIsNotNone(log)
        self.assertIn('SHP-TEST-CSV-01', log.details)

    def test_import_shipments_valid_json(self):
        """Verifies valid JSON shipment import."""
        json_data = [
            {
                "tracking_number": "SHP-TEST-JSON-01",
                "carrier": "FedEx Freight",
                "transport_mode": "Road",
                "status": "In Transit",
                "origin_city": "Chicago USA",
                "destination_warehouse_code": "WH-CENTRAL",
                "supplier_code": "SUP-PACIFIC",
                "estimated_departure": "2026-11-02",
                "estimated_arrival": "2026-11-04",
                "sku": "SKU-PWR-01",
                "item_name": "DC-DC Power Converter",
                "quantity": 200
            }
        ]
        json_bytes = json.dumps(json_data).encode('utf-8')

        res = process_shipments_import(json_bytes, 'shipment.json', dry_run=False)
        self.assertTrue(res['success'], f"JSON import failed: {res.get('errors')}")
        self.assertEqual(res['imported'], 1)

        shp = Shipment.query.filter_by(tracking_number='SHP-TEST-JSON-01').first()
        self.assertIsNotNone(shp)
        self.assertEqual(shp.carrier, 'FedEx Freight')

    def test_import_inventory_valid_csv_and_updates(self):
        """Verifies valid CSV inventory import updates existing stock or adds new SKU."""
        csv_content = (
            "warehouse_code,sku,item_name,category,quantity,reserved_quantity,reorder_point,unit_cost\n"
            "WH-EAST,SKU-NEW-01,Precision Gyroscope,Sensors,500,50,100,28.50\n"
        ).encode('utf-8')

        res = process_inventory_import(csv_content, 'inventory.csv', dry_run=False)
        self.assertTrue(res['success'])
        self.assertEqual(res['imported'], 1)

        inv = Inventory.query.filter_by(sku='SKU-NEW-01').first()
        self.assertIsNotNone(inv)
        self.assertEqual(inv.quantity, 500)
        self.assertEqual(inv.available_quantity, 450)

    def test_import_inventory_valid_json(self):
        """Verifies valid JSON inventory import."""
        json_data = [
            {
                "warehouse_code": "WH-WEST",
                "sku": "SKU-TEST-JSON-02",
                "item_name": "Optical Fiber Coupler",
                "category": "Optics",
                "quantity": 300,
                "reserved_quantity": 20,
                "reorder_point": 50,
                "unit_cost": 12.00
            }
        ]
        json_bytes = json.dumps(json_data).encode('utf-8')

        res = process_inventory_import(json_bytes, 'inv.json', dry_run=False)
        self.assertTrue(res['success'])
        self.assertEqual(res['imported'], 1)

        inv = Inventory.query.filter_by(sku='SKU-TEST-JSON-02').first()
        self.assertIsNotNone(inv)
        self.assertEqual(inv.quantity, 300)

    def test_import_preview_mode_does_not_commit(self):
        """Verifies preview mode (dry_run=True) validates data without committing to database."""
        csv_content = (
            "tracking_number,carrier,transport_mode,status,origin_city,destination_warehouse_code,supplier_code,estimated_departure,estimated_arrival,sku,item_name,quantity\n"
            "SHP-PREVIEW-01,DHL,Air,In Transit,Munich Germany,WH-EAST,SUP-APEX,2026-11-01,2026-11-05,SKU-MCU-01,Cortex-M4,50\n"
        ).encode('utf-8')

        res = process_shipments_import(csv_content, 'preview.csv', dry_run=True)
        self.assertTrue(res['success'], f"Preview failed: {res.get('errors')}")
        self.assertEqual(len(res['preview']), 1)

        # Database must NOT have this record
        shp = Shipment.query.filter_by(tracking_number='SHP-PREVIEW-01').first()
        self.assertIsNone(shp)

    def test_import_rejects_missing_required_columns(self):
        """Verifies import rejects rows with missing required columns and provides actionable errors."""
        csv_content = (
            "carrier,status,origin_city\n"
            "DHL,In Transit,Munich\n"
        ).encode('utf-8')

        res = process_shipments_import(csv_content, 'invalid.csv', dry_run=False)
        self.assertFalse(res['success'])
        self.assertTrue(any('Missing required' in err for err in res['errors']))

    def test_import_rejects_invalid_foreign_keys(self):
        """Verifies rejection when warehouse_code or supplier_code does not exist."""
        csv_content = (
            "tracking_number,carrier,transport_mode,status,origin_city,destination_warehouse_code,supplier_code,estimated_departure,estimated_arrival,sku,item_name,quantity\n"
            "SHP-BAD-FK,DHL,Air,In Transit,Berlin,WH-NONEXISTENT,SUP-APEX,2026-11-01,2026-11-05,SKU-01,Item,10\n"
        ).encode('utf-8')

        res = process_shipments_import(csv_content, 'bad_fk.csv', dry_run=False)
        self.assertFalse(res['success'])
        self.assertTrue(any('does not exist' in err for err in res['errors']))

    def test_import_rejects_file_size_exceeded(self):
        """Verifies files over 2MB are rejected safely."""
        large_bytes = b"0" * (2 * 1024 * 1024 + 10)
        res = process_shipments_import(large_bytes, 'too_large.csv', dry_run=False)
        self.assertFalse(res['success'])
        self.assertTrue(any('exceeds the 2MB' in err for err in res['errors']))

    def test_import_transactional_atomicity_on_error(self):
        """Verifies that an error in any row rolls back the entire batch."""
        csv_content = (
            "tracking_number,carrier,transport_mode,status,origin_city,destination_warehouse_code,supplier_code,estimated_departure,estimated_arrival,sku,item_name,quantity\n"
            "SHP-ATOMIC-01,DHL,Air,In Transit,Berlin,WH-EAST,SUP-APEX,2026-11-01,2026-11-05,SKU-01,Item,10\n"
            "SHP-ATOMIC-02,DHL,Air,In Transit,Berlin,WH-NONEXISTENT,SUP-APEX,2026-11-01,2026-11-05,SKU-01,Item,10\n"
        ).encode('utf-8')

        res = process_shipments_import(csv_content, 'atomic.csv', dry_run=False)
        self.assertFalse(res['success'])

        # SHP-ATOMIC-01 must NOT exist due to rollback
        shp = Shipment.query.filter_by(tracking_number='SHP-ATOMIC-01').first()
        self.assertIsNone(shp)


if __name__ == '__main__':
    unittest.main()
