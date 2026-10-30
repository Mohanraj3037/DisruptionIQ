import json
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, render_template, flash, redirect, url_for
from flask_login import login_required
from app.extensions import db
from app.models.logistics import Shipment
from app.models.governance import WebhookEvent
from app.services.audit_service import record_audit
from app.services.disruption_service import evaluate_and_record_shipment_disruption

webhooks_bp = Blueprint('webhooks', __name__)


def process_carrier_event(payload: dict) -> tuple[dict, int]:
    """
    Core business logic for processing simulated carrier events.
    Returns (response_dict, http_status_code).
    """
    # 1. Required field validation
    required_fields = ['event_id', 'tracking_number', 'event_type']
    missing_fields = [f for f in required_fields if not payload.get(f)]
    if missing_fields:
        return {
            'success': False,
            'error': f"Missing required payload fields: {', '.join(missing_fields)}"
        }, 400

    event_id = str(payload['event_id']).strip()
    tracking_number = str(payload['tracking_number']).strip()
    event_type = str(payload['event_type']).strip()
    status = payload.get('status', 'In Transit')
    delay_hours = int(payload.get('delay_hours', 0))
    location = payload.get('location', '')
    reason = payload.get('reason', '')
    new_eta_str = payload.get('estimated_arrival')

    # 2. Idempotency Check: Prevent duplicate webhook event processing
    existing_event = WebhookEvent.query.filter_by(event_identifier=event_id).first()
    if existing_event:
        return {
            'success': True,
            'status': 'already_processed',
            'message': f"Webhook event '{event_id}' has already been processed idempotently. No duplicate actions created.",
            'event_id': event_id,
            'original_processing_status': existing_event.processing_status,
            'processed_at': existing_event.processed_at.isoformat() if existing_event.processed_at else None
        }, 200

    # 3. Shipment Lookup & Existence Verification
    shipment = Shipment.query.filter_by(tracking_number=tracking_number).first()
    if not shipment:
        failed_event = WebhookEvent(
            event_identifier=event_id,
            source='CarrierAPI_Simulator',
            event_type=event_type,
            payload_json=json.dumps(payload),
            processing_status='Failed'
        )
        db.session.add(failed_event)
        record_audit(
            action='WEBHOOK_REJECTED_UNKNOWN_SHIPMENT',
            entity_type='Shipment',
            details=f"Carrier event '{event_id}' references non-existent shipment '{tracking_number}'."
        )
        db.session.commit()
        return {
            'success': False,
            'error': f"Shipment with tracking number '{tracking_number}' does not exist in DisruptionIQ."
        }, 404

    # 4. Stale Update Check
    if shipment.status == 'Delivered' and status != 'Delivered':
        return {
            'success': False,
            'error': f"Shipment '{tracking_number}' has already been delivered. Stale in-transit update rejected."
        }, 409

    # 5. Process Shipment Update & Disruption Detection
    now = datetime.now(timezone.utc)
    disruption_info = None

    if new_eta_str:
        try:
            parsed_eta = datetime.fromisoformat(new_eta_str.replace('Z', '+00:00'))
            shipment.estimated_arrival = parsed_eta
        except Exception:
            pass

    if location:
        shipment.origin_city = location

    # Delay event detection
    is_delay_event = (
        status == 'Delayed' or
        delay_hours > 0 or
        event_type in ['SHIPMENT_DELAY', 'PORT_CONGESTION', 'WEATHER_ALERT', 'CUSTOMS_HOLD']
    )

    if is_delay_event:
        shipment.status = 'Delayed'
        eff_delay = delay_hours if delay_hours > 0 else 48
        disruption = evaluate_and_record_shipment_disruption(
            shipment=shipment,
            delay_hours=eff_delay,
            reason=f"[{event_type}] {reason or 'Carrier reported disruption at ' + (location or 'checkpoint')}."
        )
        disruption_info = {
            'disruption_code': disruption.disruption_code,
            'severity': disruption.severity,
            'shortage_category': disruption.shortage_category,
            'affected_orders_count': disruption.affected_orders.count()
        }
    elif status == 'Delivered':
        shipment.status = 'Delivered'
        shipment.actual_arrival = now
        for dis in shipment.disruptions.filter_by(status='Active').all():
            dis.status = 'Resolved'
            dis.resolved_at = now

    # 6. Store WebhookEvent
    webhook_record = WebhookEvent(
        event_identifier=event_id,
        source='CarrierAPI_Simulator',
        event_type=event_type,
        payload_json=json.dumps(payload),
        processing_status='Processed',
        processed_at=now
    )
    db.session.add(webhook_record)

    # 7. Record Governance Audit Trail
    record_audit(
        action=f"WEBHOOK_{event_type}",
        entity_type='Shipment',
        entity_id=str(shipment.id),
        details=f"Processed carrier event '{event_id}' for {tracking_number}. Status: {shipment.status}. Delay: {delay_hours}h."
    )

    db.session.commit()

    return {
        'success': True,
        'message': f"Carrier event '{event_id}' processed successfully.",
        'event_id': event_id,
        'shipment': {
            'tracking_number': shipment.tracking_number,
            'status': shipment.status,
            'carrier': shipment.carrier,
            'estimated_arrival': shipment.estimated_arrival.isoformat() if shipment.estimated_arrival else None
        },
        'disruption': disruption_info
    }, 201


@webhooks_bp.route('/api/webhooks/carrier', methods=['POST'])
def receive_carrier_webhook():
    """
    Simulated carrier webhook ingestion endpoint.
    Processes shipment telemetry, updates transit records, triggers disruption evaluation,
    and enforces idempotency via unique event identifiers.
    """
    if not request.is_json:
        return jsonify({
            'success': False,
            'error': 'Unsupported Media Type: Request body must be valid JSON application/json.'
        }), 400

    payload = request.get_json()
    if not payload:
        return jsonify({'success': False, 'error': 'Empty JSON payload received.'}), 400

    result, status_code = process_carrier_event(payload)
    return jsonify(result), status_code


@webhooks_bp.route('/webhooks/simulator', methods=['GET', 'POST'])
@login_required
def simulator():
    """
    Interactive Control Tower test interface for submitting simulated carrier events
    with pre-built evaluation presets.
    """
    recent_events = WebhookEvent.query.order_by(WebhookEvent.received_at.desc()).limit(10).all()
    active_shipments = Shipment.query.order_by(Shipment.tracking_number).all()

    if request.method == 'POST':
        event_id = request.form.get('event_id', '').strip()
        tracking_number = request.form.get('tracking_number', '').strip()
        event_type = request.form.get('event_type', '').strip()
        delay_hours = int(request.form.get('delay_hours', 0))
        location = request.form.get('location', '').strip()
        reason = request.form.get('reason', '').strip()
        status = request.form.get('status', 'Delayed')

        payload = {
            'event_id': event_id,
            'tracking_number': tracking_number,
            'event_type': event_type,
            'delay_hours': delay_hours,
            'location': location,
            'reason': reason,
            'status': status
        }

        result, status_code = process_carrier_event(payload)
        if status_code in [200, 201]:
            flash(f"Webhook Success: {result.get('message')}", 'success')
        else:
            flash(f"Webhook Rejected ({status_code}): {result.get('error')}", 'danger')

        return redirect(url_for('webhooks.simulator'))

    return render_template(
        'webhooks/simulator.html',
        recent_events=recent_events,
        active_shipments=active_shipments,
        now_id=f"EVT-SIM-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    )
