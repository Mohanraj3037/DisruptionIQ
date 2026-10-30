import unittest
from app import create_app
from app.extensions import db
from app.models.user import User, Role
from app.services.auth_service import seed_demo_accounts


class BaseTestCase(unittest.TestCase):
    """Base test case setting up an in-memory SQLite database for testing."""

    def setUp(self):
        self.app = create_app('testing')
        self.app_context = self.app.app_context()
        self.app_context.push()
        self.client = self.app.test_client()

        # Create all tables in memory
        db.create_all()

    def tearDown(self):
        db.session.remove()
        db.drop_all()
        self.app_context.pop()

    def login(self, username='admin', password='DisruptionIQ@2026!'):
        """Helper to log in a user."""
        return self.client.post('/auth/login', data={
            'identifier': username,
            'password': password
        }, follow_redirects=True)

    def logout(self):
        """Helper to log out current user."""
        return self.client.get('/auth/logout', follow_redirects=True)
