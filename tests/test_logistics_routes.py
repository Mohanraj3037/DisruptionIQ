import unittest
import json
from tests.test_base import BaseTestCase
from app.services.auth_service import seed_demo_accounts
from app.services.seed_service import seed_logistics_data
from app.models.disruptions import Disruption


class TestLogisticsRoutes(BaseTestCase):

    def setUp(self):
        super().setUp()
        seed_demo_accounts()
        seed_logistics_data()

    def test_unauthenticated_access_redirects(self):
        """Verifies unauthenticated requests to all logistics pages redirect to login."""
        endpoints = [
            '/suppliers',
            '/warehouses',
            '/shipments',
            '/inventory',
            '/orders',
            '/disruptions',
            '/import',
            '/webhooks/simulator'
        ]
        for ep in endpoints:
            resp = self.client.get(ep)
            self.assertEqual(resp.status_code, 302, f"Endpoint {ep} did not redirect unauthenticated user")
            self.assertIn('/login', resp.headers['Location'])

    def test_suppliers_page_renders_and_searches(self):
        """Verifies suppliers page renders with seeded suppliers and filters by search query."""
        self.login('admin', 'DisruptionIQ@2026!')
        resp = self.client.get('/suppliers')
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b'Global Suppliers Directory', resp.data)
        self.assertIn(b'SUP-PACIFIC', resp.data)
        self.assertIn(b'SUP-EURO', resp.data)

        # Search test
        resp_search = self.client.get('/suppliers?q=Pacific')
        self.assertEqual(resp_search.status_code, 200)
        self.assertIn(b'SUP-PACIFIC', resp_search.data)

    def test_warehouses_page_renders(self):
        """Verifies warehouses page renders all 3 hubs with live valuations."""
        self.login('admin', 'DisruptionIQ@2026!')
        resp = self.client.get('/warehouses')
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b'Distribution Hubs &amp; Warehouses', resp.data)
        self.assertIn(b'WH-EAST', resp.data)
        self.assertIn(b'WH-CENTRAL', resp.data)
        self.assertIn(b'WH-WEST', resp.data)

    def test_shipments_page_renders_and_filters(self):
        """Verifies shipments page renders and filters by status tab."""
        self.login('admin', 'DisruptionIQ@2026!')
        resp = self.client.get('/shipments')
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b'Shipments &amp; In-Transit Cargo', resp.data)
        self.assertIn(b'SHP-2026-003', resp.data)

        # Delayed filter
        resp_delayed = self.client.get('/shipments?status=delayed')
        self.assertEqual(resp_delayed.status_code, 200)
        self.assertIn(b'SHP-2026-003', resp_delayed.data)

    def test_inventory_page_renders_and_filters(self):
        """Verifies inventory page renders stock balances and filters by warehouse and low stock."""
        self.login('admin', 'DisruptionIQ@2026!')
        resp = self.client.get('/inventory')
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b'Multi-Echelon Inventory Control', resp.data)
        self.assertIn(b'SKU-MCU-01', resp.data)

        # Filter by warehouse
        resp_wh = self.client.get('/inventory?warehouse=WH-EAST')
        self.assertEqual(resp_wh.status_code, 200)
        self.assertIn(b'WH-EAST', resp_wh.data)

        # Low stock filter
        resp_low = self.client.get('/inventory?low_stock=true')
        self.assertEqual(resp_low.status_code, 200)

    def test_customer_orders_page_renders_and_filters(self):
        """Verifies customer orders page renders orders and filters by tier and priority."""
        self.login('admin', 'DisruptionIQ@2026!')
        resp = self.client.get('/orders')
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b'Customer Orders &amp; Fulfilment Queue', resp.data)
        self.assertIn(b'ORD-2026-001', resp.data)

        # Filter by Platinum tier
        resp_plat = self.client.get('/orders?tier=platinum')
        self.assertEqual(resp_plat.status_code, 200)
        self.assertIn(b'Platinum', resp_plat.data)

    def test_disruptions_page_and_detail_view(self):
        """Verifies disruptions listing and individual detail view with affected customer orders."""
        self.login('admin', 'DisruptionIQ@2026!')
        resp = self.client.get('/disruptions')
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b'Active Disruption Monitoring', resp.data)
        self.assertIn(b'DIS-2026-001', resp.data)

        # View detail
        dis = Disruption.query.filter_by(disruption_code='DIS-2026-001').first()
        self.assertIsNotNone(dis)
        resp_detail = self.client.get(f'/disruptions/{dis.id}')
        self.assertEqual(resp_detail.status_code, 200)
        self.assertIn(b'DIS-2026-001', resp_detail.data)
        self.assertIn(b'ORD-2026-004', resp_detail.data)

    def test_dashboard_reflects_seeded_telemetry(self):
        """Verifies dashboard KPI metrics and charts reflect seeded database records."""
        self.login('admin', 'DisruptionIQ@2026!')
        resp = self.client.get('/')
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b'Logistics Control Tower', resp.data)
        # Verify active disruption cards
        self.assertIn(b'Active Disruptions', resp.data)
        self.assertIn(b'DIS-2026-001', resp.data)

        # Charts API
        resp_chart = self.client.get('/api/dashboard-charts')
        self.assertEqual(resp_chart.status_code, 200)
        chart_data = json.loads(resp_chart.data)
        # Disruptions by severity data must have non-zero entries
        self.assertGreater(sum(chart_data['disruptions_by_severity']['data']), 0)
        # Shipments by status data must have non-zero entries
        self.assertGreater(sum(chart_data['shipments_by_status']['data']), 0)


if __name__ == '__main__':
    unittest.main()
