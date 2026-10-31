import unittest
from app.extensions import db
from app.models.user import User, Role
from app.services.auth_service import seed_demo_accounts
from tests.test_base import BaseTestCase


class TestAuth(BaseTestCase):

    def setUp(self):
        super().setUp()
        seed_demo_accounts()

    def test_login_page_renders(self):
        response = self.client.get('/auth/login')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'DisruptionIQ', response.data)
        self.assertIn(b'Access Control Tower', response.data)

    def test_successful_login_with_username(self):
        response = self.login(username='admin', password='DisruptionIQ@2026!')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Logistics Control Tower', response.data)

    def test_successful_login_with_email(self):
        response = self.login(username='analyst@disruptioniq.local', password='DisruptionIQ@2026!')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'Logistics Control Tower', response.data)

    def test_failed_login_with_invalid_password(self):
        response = self.login(username='admin', password='WrongPassword!')
        self.assertIn(b'Invalid credentials', response.data)

    def test_logout(self):
        self.login('admin', 'DisruptionIQ@2026!')
        response = self.logout()
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'safely signed out', response.data)

    def test_unauthenticated_access_redirects_to_login(self):
        response = self.client.get('/', follow_redirects=False)
        self.assertEqual(response.status_code, 302)
        self.assertIn('/auth/login', response.headers['Location'])

    def test_role_restriction_audit_logs(self):
        # Warehouse operator should be blocked (HTTP 403) from /audit-logs
        self.login('warehouse', 'DisruptionIQ@2026!')
        response = self.client.get('/audit-logs')
        self.assertEqual(response.status_code, 403)
        self.assertIn(b'Access Denied', response.data)

        # Administrator should be granted access (HTTP 200)
        self.logout()
        self.login('admin', 'DisruptionIQ@2026!')
        admin_resp = self.client.get('/audit-logs')
        self.assertEqual(admin_resp.status_code, 200)
        self.assertIn(b'Governance Audit Trail', admin_resp.data)

    def test_role_restriction_approvals(self):
        # Operations Analyst should be blocked (HTTP 403) from /approvals
        self.login('analyst', 'DisruptionIQ@2026!')
        response = self.client.get('/approvals')
        self.assertEqual(response.status_code, 403)

        # Procurement Approver should be granted access (HTTP 200)
        self.logout()
        self.login('approver', 'DisruptionIQ@2026!')
        approver_resp = self.client.get('/approvals')
        self.assertEqual(approver_resp.status_code, 200)
        self.assertIn(b'Procurement &amp; Financial Approvals', approver_resp.data)


if __name__ == '__main__':
    unittest.main()
