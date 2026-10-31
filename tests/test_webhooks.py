import unittest
import json
from tests.test_base import BaseTestCase
from app.extensions import db
from app.services.auth_service import seed_demo_accounts
from app.services.seed_service import seed_logistics_data
from app.models.logistics import Shipment
from app.models.disruptions import Disruption
from app.models.governance import WebhookEvent, AuditLog


class TestWebhooks(BaseTestCase):

    def setUp(self):
        super().setUp()
        seed_demo_accounts()
        seed_logistics_data()
        self.login('admin', 'DisruptionIQ@2026!')

    def test_carrier_webhook_valid_delay_event(self):
        """Verifies carrier delay event creates disruption and links affected orders."""
        payload = {
            'event_id': 'EVT-TEST-DELAY-01',
            'tracking_number': 'SHP-2026-004',
            'event_type': 'PORT_CONGESTION',
            'status': 'Delayed',
            'delay_hours': 72,
            'location': 'Port of Oakland, CA',
            'reason': 'Berth allocation delay and crane breakdown.',
            'estimated_arrival': '2026-11-20T12:00:00Z'
        }

        resp = self.client.post(
            '/api/webhooks/carrier',
            data=json.dumps(payload),
            content_type='application/json'
        )
        self.assertEqual(resp.status_code, 201)
        data = json.loads(resp.data)
        self.assertTrue(data['success'])
        self.assertIsNotNone(data.get('disruption'))

        # Verify shipment status updated
        shp = Shipment.query.filter_by(tracking_number='SHP-2026-004').first()
        self.assertEqual(shp.status, 'Delayed')

        # Verify WebhookEvent stored
        evt = WebhookEvent.query.filter_by(event_identifier='EVT-TEST-DELAY-01').first()
        self.assertIsNotNone(evt)
        self.assertEqual(evt.processing_status, 'Processed')

        # Verify Audit Log
        log = AuditLog.query.filter_by(action='WEBHOOK_PORT_CONGESTION').first()
        self.assertIsNotNone(log)

    def test_carrier_webhook_idempotency(self):
        """Verifies duplicate webhook event IDs are handled idempotently without duplicate disruptions."""
        payload = {
            'event_id': 'EVT-IDEMPOTENT-01',
            'tracking_number': 'SHP-2026-002',
            'event_type': 'SHIPMENT_DELAY',
            'status': 'Delayed',
            'delay_hours': 48,
            'location': 'Kenosha, WI',
            'reason': 'Severe snowstorm.'
        }

        # First post
        resp1 = self.client.post(
            '/api/webhooks/carrier',
            data=json.dumps(payload),
            content_type='application/json'
        )
        self.assertEqual(resp1.status_code, 201)

        disruptions_count_1 = Disruption.query.count()

        # Second post with identical event_id
        resp2 = self.client.post(
            '/api/webhooks/carrier',
            data=json.dumps(payload),
            content_type='application/json'
        )
        self.assertEqual(resp2.status_code, 200)
        data2 = json.loads(resp2.data)
        self.assertEqual(data2['status'], 'already_processed')
        self.assertIn('already been processed idempotently', data2['message'])

        # No duplicate disruptions created
        disruptions_count_2 = Disruption.query.count()
        self.assertEqual(disruptions_count_1, disruptions_count_2)

    def test_carrier_webhook_rejects_unknown_shipment(self):
        """Verifies 404 response and failed webhook event record when shipment is not found."""
        payload = {
            'event_id': 'EVT-UNKNOWN-SHP',
            'tracking_number': 'SHP-DOES-NOT-EXIST',
            'event_type': 'STATUS_UPDATE',
            'status': 'In Transit'
        }

        resp = self.client.post(
            '/api/webhooks/carrier',
            data=json.dumps(payload),
            content_type='application/json'
        )
        self.assertEqual(resp.status_code, 404)
        data = json.loads(resp.data)
        self.assertFalse(data['success'])
        self.assertIn('does not exist', data['error'])

        # Verify failure logged in WebhookEvent
        evt = WebhookEvent.query.filter_by(event_identifier='EVT-UNKNOWN-SHP').first()
        self.assertIsNotNone(evt)
        self.assertEqual(evt.processing_status, 'Failed')

    def test_carrier_webhook_rejects_stale_update_on_delivered_shipment(self):
        """Verifies 409 Conflict when in-transit update arrives for an already delivered shipment."""
        # Find delivered shipment
        shp = Shipment.query.filter_by(status='Delivered').first()
        self.assertIsNotNone(shp)

        payload = {
            'event_id': 'EVT-STALE-01',
            'tracking_number': shp.tracking_number,
            'event_type': 'CHECKPOINT_UPDATE',
            'status': 'In Transit',
            'location': 'Some Checkpoint'
        }

        resp = self.client.post(
            '/api/webhooks/carrier',
            data=json.dumps(payload),
            content_type='application/json'
        )
        self.assertEqual(resp.status_code, 409)
        data = json.loads(resp.data)
        self.assertFalse(data['success'])
        self.assertIn('already been delivered', data['error'])

    def test_carrier_webhook_rejects_non_json(self):
        """Verifies 400 when request is not JSON."""
        resp = self.client.post('/api/webhooks/carrier', data='plain text', content_type='text/plain')
        self.assertEqual(resp.status_code, 400)

    def test_carrier_webhook_rejects_missing_fields(self):
        """Verifies 400 when required fields are missing."""
        payload = {'tracking_number': 'SHP-2026-001'}  # missing event_id and event_type
        resp = self.client.post(
            '/api/webhooks/carrier',
            data=json.dumps(payload),
            content_type='application/json'
        )
        self.assertEqual(resp.status_code, 400)
        data = json.loads(resp.data)
        self.assertIn('Missing required payload fields', data['error'])

    def test_webhook_simulator_page_and_submission(self):
        """Verifies simulator page renders and processes form submissions."""
        resp_get = self.client.get('/webhooks/simulator')
        self.assertEqual(resp_get.status_code, 200)
        self.assertIn(b'Carrier Webhook Simulator', resp_get.data)

        # Submit form targeting in-transit shipment
        form_data = {
            'event_id': 'EVT-SIM-FORM-01',
            'tracking_number': 'SHP-2026-001',
            'event_type': 'SHIPMENT_DELAY',
            'status': 'Delayed',
            'delay_hours': 36,
            'location': 'Hamburg, Germany',
            'reason': 'Dock workers strike'
        }
        resp_post = self.client.post('/webhooks/simulator', data=form_data, follow_redirects=True)
        self.assertEqual(resp_post.status_code, 200)
        self.assertIn(b'Webhook Success', resp_post.data)


if __name__ == '__main__':
    unittest.main()
