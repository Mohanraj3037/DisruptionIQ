from datetime import datetime, timezone
from flask_login import UserMixin
from werkzeug.security import generate_password_hash, check_password_hash
from app.extensions import db, login_manager


class Role:
    OPERATIONS_ANALYST = 'Operations Analyst'
    SUPPLY_CHAIN_MANAGER = 'Supply Chain Manager'
    WAREHOUSE_OPERATOR = 'Warehouse Operator'
    PROCUREMENT_APPROVER = 'Procurement Approver'
    ADMINISTRATOR = 'Administrator'

    ALL_ROLES = [
        OPERATIONS_ANALYST,
        SUPPLY_CHAIN_MANAGER,
        WAREHOUSE_OPERATOR,
        PROCUREMENT_APPROVER,
        ADMINISTRATOR,
    ]


class User(UserMixin, db.Model):
    __tablename__ = 'users'

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False, index=True)
    email = db.Column(db.String(120), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(256), nullable=False)
    role = db.Column(db.String(64), nullable=False, default=Role.OPERATIONS_ANALYST)
    full_name = db.Column(db.String(120), nullable=True)
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    last_login = db.Column(db.DateTime, nullable=True)

    # Relationships
    audit_logs = db.relationship('AuditLog', back_populates='user', lazy='dynamic')
    approvals_requested = db.relationship(
        'Approval',
        back_populates='requester',
        foreign_keys='Approval.requester_id',
        lazy='dynamic'
    )
    approvals_reviewed = db.relationship(
        'Approval',
        back_populates='approver',
        foreign_keys='Approval.approver_id',
        lazy='dynamic'
    )
    recovery_plans_created = db.relationship(
        'RecoveryPlan',
        back_populates='created_by',
        foreign_keys='RecoveryPlan.created_by_id',
        lazy='dynamic'
    )
    recovery_plans_executed = db.relationship(
        'RecoveryPlan',
        back_populates='executed_by',
        foreign_keys='RecoveryPlan.executed_by_id',
        lazy='dynamic'
    )
    notifications = db.relationship('Notification', back_populates='recipient_user', lazy='dynamic')

    def set_password(self, password: str) -> None:
        """Hash and store the user password."""
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        """Verify the user password against stored hash."""
        return check_password_hash(self.password_hash, password)

    def has_role(self, *roles: str) -> bool:
        """Check if user has any of the specified roles."""
        return self.role in roles or self.role == Role.ADMINISTRATOR

    def __repr__(self) -> str:
        return f'<User {self.username} ({self.role})>'


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))
