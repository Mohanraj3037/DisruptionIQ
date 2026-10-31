import unittest
from datetime import datetime, timezone, timedelta
from tests.test_base import BaseTestCase
from app.extensions import db
from app.models.user import User, Role
from app.models.logistics import Supplier, Warehouse, Inventory, Shipment, ShipmentItem
from app.models.orders import CustomerOrder, OrderItem
from app.models.disruptions import Disruption


class TestRiskRoutes(BaseTestCase):
    """Integration tests for the Risk Queue web interface, API, and Dashboard metrics."""

    def setUp(self):
        super().setUp()
        self.now = datetime.now(timezone.utc)

        # Create demo accounts
        self.admin = User(username='admin', email='admin@test.local', role=Role.ADMINISTRATOR)
        self.admin.set_password('DisruptionIQ@2026!')

        self.analyst = User(username='analyst', email='analyst@test.local', role=Role.OPERATIONS_ANALYST)
        self.analyst.set_password('DisruptionIQ@2026!')

        self.manager = User(username='manager', email='manager@test.local', role=Role.SUPPLY_CHAIN_MANAGER)
        self.manager.set_password('DisruptionIQ@2026!')

        self.wh_user = User(username='wh_operator', email='wh@test.local', role=Role.WAREHOUSE_OPERATOR)
        self.wh_user.set_password('DisruptionIQ@2026!')

        self.approver = User(username='approver', email='approver@test.local', role=Role.PROCUREMENT_APPROVER)
        self.approver.set_password('DisruptionIQ@2026!')

        db.session.add_all([self.admin, self.analyst, self.manager, self.wh_user, self.approver])

        # Create logistics entities
        self.sup = Supplier(code='SUP-TEST-R', name='Test Supplier', lead_time_days=7)
        self.wh = Warehouse(code='WH-TEST-R', name='Test Hub', location='Amsterdam')
        db.session.add_all([self.sup, self.wh])
        db.session.flush()

        self.inv = Inventory(
            warehouse_id=self.wh.id,
            sku='SKU-ROUTE-01',
            item_name='Industrial Sensor',
            quantity=15,
            reserved_quantity=10,  # 5 available
            reorder_point=20
        )
        db.session.add(self.inv)

        self.disruption = Disruption(
            disruption_code='DIS-ROUTE-001',
            title='Transit Weather Alert',
            disruption_type='Severe Weather',
            severity='Critical',
            status='Active',
            shortage_category='Potential Shortage',
            warehouse_id=self.wh.id,
            estimated_delay_hours=48,
            detected_at=self.now
        )
        db.session.add(self.disruption)
        db.session.flush()

        self.order = CustomerOrder(
            order_number='ORD-ROUTE-001',
            customer_name='Philips Medical',
            customer_tier='Platinum',
            priority='Critical',
            status='At Risk',
            assigned_warehouse_id=self.wh.id,
            delivery_deadline=self.now + timedelta(hours=36),
            total_value=2400.0
        )
        db.session.add(self.order)
        db.session.flush()

        self.ord_item = OrderItem(
            order_id=self.order.id,
            sku='SKU-ROUTE-01',
            item_name='Industrial Sensor',
            quantity=25,
            unit_price=96.0
        )
        db.session.add(self.ord_item)

        self.disruption.affected_orders.append(self.order)
        db.session.commit()

    def test_unauthenticated_access_redirects(self):
        """Verifies unauthenticated requests to risk queue and API redirect to login."""
        res_page = self.client.get('/risk-queue')
        self.assertEqual(res_page.status_code, 302)
        self.assertIn('/auth/login', res_page.headers['Location'])

        res_api = self.client.get('/api/risk-queue')
        self.assertEqual(res_api.status_code, 302)

    def test_authenticated_access_and_roles(self):
        """Verifies all authorized roles can access the Risk Queue."""
        roles_to_test = ['admin', 'analyst', 'manager', 'wh_operator', 'approver']
        for username in roles_to_test:
            self.login(username)
            res = self.client.get('/risk-queue')
            self.assertEqual(res.status_code, 200, f"Role {username} could not access /risk-queue")
            self.assertIn(b'Ranked Customer Order Risk Queue', res.data)
            self.assertIn(b'ORD-ROUTE-001', res.data)
            self.logout()

    def test_api_risk_queue_returns_valid_json_and_structure(self):
        """Verifies GET /api/risk-queue returns structured JSON with scoring weights and orders."""
        self.login('analyst')
        res = self.client.get('/api/risk-queue')
        self.assertEqual(res.status_code, 200)

        data = res.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['total_count'], 1)
        self.assertEqual(data['scoring_version'], '1.0-deterministic')
        self.assertIn('deadline_risk', data['weights'])
        self.assertIn('shortage_risk', data['weights'])

        first_ord = data['orders'][0]
        self.assertEqual(first_ord['order_number'], 'ORD-ROUTE-001')
        self.assertGreater(first_ord['final_risk_score'], 0)
        self.assertIn('components', first_ord)

    def test_risk_queue_filtering(self):
        """Verifies web filtering by severity, priority, status, and search query."""
        self.login('analyst')

        # 1. Matching severity filter
        res_crit = self.client.get('/risk-queue?severity=critical')
        self.assertEqual(res_crit.status_code, 200)
        self.assertIn(b'ORD-ROUTE-001', res_crit.data)

        # 2. Non-matching severity filter
        res_low = self.client.get('/risk-queue?severity=low')
        self.assertEqual(res_low.status_code, 200)
        self.assertIn(b'No Orders Matching Active Filter', res_low.data)

        # 3. Search query matching order number
        res_q = self.client.get('/risk-queue?q=ORD-ROUTE')
        self.assertEqual(res_q.status_code, 200)
        self.assertIn(b'ORD-ROUTE-001', res_q.data)

        # 4. Search query non-matching
        res_q_miss = self.client.get('/risk-queue?q=NONEXISTENT')
        self.assertEqual(res_q_miss.status_code, 200)
        self.assertIn(b'No Orders Matching Active Filter', res_q_miss.data)

    def test_dashboard_reflects_risk_scoring_and_top_orders(self):
        """Verifies Dashboard renders risk metrics, top at-risk orders, and chart telemetry."""
        self.login('analyst')
        res_dash = self.client.get('/')
        self.assertEqual(res_dash.status_code, 200)
        self.assertIn(b'Critical &amp; High Risk Orders', res_dash.data)
        self.assertIn(b'Highest-Risk Customer Orders', res_dash.data)
        self.assertIn(b'ORD-ROUTE-001', res_dash.data)

        # Charts API
        res_charts = self.client.get('/api/dashboard-charts')
        self.assertEqual(res_charts.status_code, 200)
        charts_data = res_charts.get_json()
        self.assertIn('risk_distribution', charts_data)
        self.assertEqual(charts_data['risk_distribution']['labels'], ['Critical', 'High', 'Medium', 'Low'])
        self.assertGreaterEqual(sum(charts_data['risk_distribution']['data']), 1)

    def test_disruption_detail_view_renders_impact_chain_and_evidence(self):
        """Verifies /disruptions/<id> displays the visual impact chain and evidence panel."""
        self.login('analyst')
        res_detail = self.client.get(f'/disruptions/{self.disruption.id}')
        self.assertEqual(res_detail.status_code, 200)
        self.assertIn(b'Multi-Echelon Supply-Chain Impact Chain', res_detail.data)
        self.assertIn(b'Affected Customer Orders &amp; Risk Evidence Panel', res_detail.data)
        self.assertIn(b'ORD-ROUTE-001', res_detail.data)
        self.assertIn(b'Deadline (35%)', res_detail.data)
        self.assertIn(b'Shortage (30%)', res_detail.data)


if __name__ == '__main__':
    unittest.main()
