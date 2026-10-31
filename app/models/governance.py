from datetime import datetime, timezone
from sqlalchemy import UniqueConstraint
from app.extensions import db


class Approval(db.Model):
    __tablename__ = 'approvals'

    id = db.Column(db.Integer, primary_key=True)
    recovery_plan_id = db.Column(db.Integer, db.ForeignKey('recovery_plans.id', ondelete='CASCADE'), nullable=False, index=True)
    requester_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False, index=True)
    approver_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True, index=True)
    
    required_role = db.Column(db.String(64), default='Procurement Approver', nullable=False)
    status = db.Column(db.String(32), default='Pending', nullable=False)  # Pending, Approved, Rejected
    comments = db.Column(db.Text, nullable=True)
    
    requested_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    decision_at = db.Column(db.DateTime, nullable=True)

    # Relationships
    recovery_plan = db.relationship('RecoveryPlan', back_populates='approvals')
    requester = db.relationship('User', foreign_keys=[requester_id], back_populates='approvals_requested')
    approver = db.relationship('User', foreign_keys=[approver_id], back_populates='approvals_reviewed')

    def __repr__(self) -> str:
        return f'<Approval for Plan {self.recovery_plan_id} [{self.status}]>'


class AuditLog(db.Model):
    __tablename__ = 'audit_logs'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True, index=True)
    action = db.Column(db.String(64), nullable=False)  # e.g. LOGIN, LOGOUT, CREATE_USER, APPROVE_PLAN
    entity_type = db.Column(db.String(64), nullable=False)  # User, Disruption, RecoveryPlan, Approval, etc.
    entity_id = db.Column(db.String(64), nullable=True)
    details = db.Column(db.Text, nullable=True)
    ip_address = db.Column(db.String(45), nullable=True)
    timestamp = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False, index=True)

    # Relationships
    user = db.relationship('User', back_populates='audit_logs')

    def __repr__(self) -> str:
        return f'<AuditLog {self.action} on {self.entity_type} at {self.timestamp}>'


class WebhookEvent(db.Model):
    __tablename__ = 'webhook_events'
    __table_args__ = (
        UniqueConstraint('event_identifier', name='uq_webhook_event_identifier'),
    )

    id = db.Column(db.Integer, primary_key=True)
    event_identifier = db.Column(db.String(120), unique=True, nullable=False, index=True)
    source = db.Column(db.String(64), nullable=False)  # CarrierAPI, IoTTracker, PortAuthority, AIS, etc.
    event_type = db.Column(db.String(64), nullable=False)  # SHIPMENT_DELAY, PORT_CONGESTION, WEATHER_ALERT
    payload_json = db.Column(db.Text, nullable=False)
    processing_status = db.Column(db.String(32), default='Received', nullable=False)  # Received, Processed, Failed, Ignored
    received_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    processed_at = db.Column(db.DateTime, nullable=True)

    def __repr__(self) -> str:
        return f'<WebhookEvent {self.event_identifier} from {self.source} [{self.processing_status}]>'


class Notification(db.Model):
    __tablename__ = 'notifications'

    id = db.Column(db.Integer, primary_key=True)
    recipient_role = db.Column(db.String(64), nullable=True, index=True)
    recipient_user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True, index=True)
    title = db.Column(db.String(160), nullable=False)
    message = db.Column(db.Text, nullable=False)
    category = db.Column(db.String(32), default='Info', nullable=False)  # Info, Warning, Alert, Critical
    is_read = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    # Relationships
    recipient_user = db.relationship('User', back_populates='notifications')

    def __repr__(self) -> str:
        return f'<Notification {self.title} [{self.category}]>'
