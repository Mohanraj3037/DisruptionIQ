from datetime import datetime, timezone
from app.extensions import db


disruption_affected_orders = db.Table(
    'disruption_affected_orders',
    db.Column('disruption_id', db.Integer, db.ForeignKey('disruptions.id', ondelete='CASCADE'), primary_key=True),
    db.Column('customer_order_id', db.Integer, db.ForeignKey('customer_orders.id', ondelete='CASCADE'), primary_key=True)
)


class Disruption(db.Model):
    __tablename__ = 'disruptions'

    id = db.Column(db.Integer, primary_key=True)
    disruption_code = db.Column(db.String(64), unique=True, nullable=False, index=True)
    title = db.Column(db.String(160), nullable=False)
    disruption_type = db.Column(db.String(64), nullable=False)  # Port Congestion, Severe Weather, Carrier Delay, Supplier Shortage, Geopolitical
    severity = db.Column(db.String(32), default='Medium', nullable=False)  # Critical, High, Medium, Low
    status = db.Column(db.String(32), default='Active', nullable=False)    # Active, Investigating, Mitigated, Resolved
    shortage_category = db.Column(db.String(64), default='None', nullable=False)  # None, Potential Shortage, Confirmed Shortage
    
    shipment_id = db.Column(db.Integer, db.ForeignKey('shipments.id'), nullable=True, index=True)
    warehouse_id = db.Column(db.Integer, db.ForeignKey('warehouses.id'), nullable=True, index=True)
    location = db.Column(db.String(120), nullable=True)
    description = db.Column(db.Text, nullable=True)
    estimated_delay_hours = db.Column(db.Integer, default=0, nullable=False)
    
    detected_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    resolved_at = db.Column(db.DateTime, nullable=True)

    # Relationships
    shipment = db.relationship('Shipment', back_populates='disruptions')
    warehouse = db.relationship('Warehouse')
    affected_orders = db.relationship(
        'CustomerOrder',
        secondary=disruption_affected_orders,
        backref=db.backref('linked_disruptions', lazy='dynamic'),
        lazy='dynamic'
    )
    recovery_plans = db.relationship('RecoveryPlan', back_populates='disruption', cascade='all, delete-orphan', lazy='dynamic')

    @property
    def delay_hours(self) -> int:
        return self.estimated_delay_hours

    @property
    def estimated_financial_impact(self) -> float:
        """Computes total financial value of affected customer orders."""
        return sum(o.total_amount for o in self.affected_orders.all())

    def __repr__(self) -> str:
        return f'<Disruption {self.disruption_code} [{self.severity}]: {self.title}>'


class RecoveryPlan(db.Model):
    __tablename__ = 'recovery_plans'

    id = db.Column(db.Integer, primary_key=True)
    plan_code = db.Column(db.String(64), unique=True, nullable=False, index=True)
    disruption_id = db.Column(db.Integer, db.ForeignKey('disruptions.id', ondelete='CASCADE'), nullable=False, index=True)
    customer_order_id = db.Column(db.Integer, db.ForeignKey('customer_orders.id'), nullable=True, index=True)
    
    title = db.Column(db.String(160), nullable=False)
    strategy_type = db.Column(db.String(64), nullable=False)  # Inter-Warehouse Stock Transfer, Alternative Supplier, Expedited Freight, Order Reprioritisation, Split Allocation
    status = db.Column(db.String(32), default='Draft', nullable=False)  # Draft, Pending Approval, Approved, Execution Ready, Executed, Rejected, Changes Requested, Cancelled, Execution Failed
    
    sku = db.Column(db.String(64), nullable=True)
    quantity = db.Column(db.Integer, default=0, nullable=False)
    source_warehouse_id = db.Column(db.Integer, db.ForeignKey('warehouses.id'), nullable=True, index=True)
    destination_warehouse_id = db.Column(db.Integer, db.ForeignKey('warehouses.id'), nullable=True, index=True)
    source_location = db.Column(db.String(120), nullable=True)
    destination_location = db.Column(db.String(120), nullable=True)
    
    estimated_cost = db.Column(db.Float, default=0.0, nullable=False)
    estimated_delay_reduction_hours = db.Column(db.Integer, default=0, nullable=False)
    
    description = db.Column(db.Text, nullable=True)
    rationale = db.Column(db.Text, nullable=True)
    version = db.Column(db.Integer, default=1, nullable=False)
    approval_version = db.Column(db.Integer, nullable=True)
    
    created_by_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True, index=True)
    executed_by_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True, index=True)
    executed_at = db.Column(db.DateTime, nullable=True)
    execution_idempotency_key = db.Column(db.String(120), unique=True, nullable=True, index=True)
    execution_notes = db.Column(db.Text, nullable=True)
    execution_result_json = db.Column(db.Text, nullable=True)
    
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    # Relationships
    disruption = db.relationship('Disruption', back_populates='recovery_plans')
    customer_order = db.relationship('CustomerOrder', back_populates='recovery_plans')
    created_by = db.relationship('User', foreign_keys=[created_by_id], back_populates='recovery_plans_created')
    executed_by = db.relationship('User', foreign_keys=[executed_by_id], back_populates='recovery_plans_executed')
    source_warehouse = db.relationship('Warehouse', foreign_keys=[source_warehouse_id])
    destination_warehouse = db.relationship('Warehouse', foreign_keys=[destination_warehouse_id])
    actions = db.relationship('RecoveryAction', back_populates='recovery_plan', cascade='all, delete-orphan', lazy='dynamic')
    approvals = db.relationship('Approval', back_populates='recovery_plan', cascade='all, delete-orphan', lazy='dynamic')

    def is_approval_valid(self) -> bool:
        """Returns True if the current plan content matches the approved version snapshot."""
        return self.status == 'Approved' and self.approval_version == self.version

    def __repr__(self) -> str:
        return f'<RecoveryPlan {self.plan_code} ({self.status})>'


class RecoveryAction(db.Model):
    __tablename__ = 'recovery_actions'

    id = db.Column(db.Integer, primary_key=True)
    recovery_plan_id = db.Column(db.Integer, db.ForeignKey('recovery_plans.id', ondelete='CASCADE'), nullable=False, index=True)
    action_sequence = db.Column(db.Integer, default=1, nullable=False)
    action_type = db.Column(db.String(64), nullable=False)
    description = db.Column(db.Text, nullable=False)
    status = db.Column(db.String(32), default='Pending', nullable=False)  # Pending, In Progress, Completed, Failed
    cost = db.Column(db.Float, default=0.0, nullable=False)
    assigned_to_role = db.Column(db.String(64), nullable=True)
    executed_at = db.Column(db.DateTime, nullable=True)
    result_details = db.Column(db.Text, nullable=True)

    # Relationships
    recovery_plan = db.relationship('RecoveryPlan', back_populates='actions')

    def __repr__(self) -> str:
        return f'<RecoveryAction #{self.action_sequence} for Plan {self.recovery_plan_id}>'

