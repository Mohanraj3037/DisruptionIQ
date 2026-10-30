import unittest
import json
from app.services.auth_service import seed_demo_accounts
from tests.test_base import BaseTestCase


class TestRoutes(BaseTestCase):

    def setUp(self):
        super().setUp()
        seed_demo_accounts()
        self.login('admin', 'DisruptionIQ@2026!')

    def test_dashboard_renders_with_zero_empty_state(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Logistics Control Tower', response.data)
        # Verify empty state message displays cleanly
        self.assertIn(b'Zero Disruption Records in Database', response.data)
        self.assertIn(b'No Orders Stored in Database', response.data)

    def test_dashboard_charts_api(self):
        response = self.client.get('/api/dashboard-charts')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content_type, 'application/json')
        data = json.loads(response.data)

        self.assertIn('disruptions_by_severity', data)
        self.assertIn('shipments_by_status', data)
        self.assertEqual(data['disruptions_by_severity']['labels'], ['Critical', 'High', 'Medium', 'Low'])
        self.assertEqual(data['shipments_by_status']['labels'], ['In Transit', 'Delayed', 'Scheduled', 'Delivered'])

    def test_placeholders_disruptions(self):
        response = self.client.get('/disruptions')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Disruption Monitoring', response.data)

    def test_placeholders_orders(self):
        response = self.client.get('/orders')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Customer Orders &amp; Fulfilment', response.data)

    def test_placeholders_recovery_plans(self):
        response = self.client.get('/recovery-plans')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Recovery Plans &amp; Mitigation', response.data)

    def test_custom_404_page(self):
        response = self.client.get('/nonexistent-route-404')
        self.assertEqual(response.status_code, 404)
        self.assertIn(b'404', response.data)
        self.assertIn(b'Page Not Found', response.data)


if __name__ == '__main__':
    unittest.main()
