from datetime import datetime, timezone
from sqlalchemy import CheckConstraint
from app.extensions import db


class CustomerOrder(db.Model):
    __tablename__ = 'customer_orders'

    id = db.Column(db.Integer, primary_key=True)
    order_number = db.Column(db.String(64), unique=True, nullable=False, index=True)
    customer_name = db.Column(db.String(120), nullable=False)
    customer_tier = db.Column(db.String(32), default='Standard', nullable=False)  # Platinum, Gold, Standard
    status = db.Column(db.String(32), default='Pending', nullable=False)          # Pending, Allocated, Shipped, Delivered, At Risk, Cancelled
    priority = db.Column(db.String(32), default='Medium', nullable=False)         # Low, Medium, High, Critical
    total_value = db.Column(db.Float, default=0.0, nullable=False)
    assigned_warehouse_id = db.Column(db.Integer, db.ForeignKey('warehouses.id'), nullable=True, index=True)
    order_date = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    delivery_deadline = db.Column(db.DateTime, nullable=True)

    # Relationships
    assigned_warehouse = db.relationship('Warehouse')
    items = db.relationship('OrderItem', back_populates='order', cascade='all, delete-orphan', lazy='dynamic')
    recovery_plans = db.relationship('RecoveryPlan', back_populates='customer_order', lazy='dynamic')

    @property
    def total_amount(self) -> float:
        return self.total_value or 0.0

    @property
    def disruptions(self):
        return self.linked_disruptions

    def __repr__(self) -> str:
        return f'<CustomerOrder {self.order_number} ({self.status})>'


class OrderItem(db.Model):
    __tablename__ = 'order_items'
    __table_args__ = (
        CheckConstraint('quantity > 0', name='ck_orderitem_quantity_positive'),
        CheckConstraint('unit_price >= 0', name='ck_orderitem_unit_price_non_negative'),
    )

    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.Integer, db.ForeignKey('customer_orders.id', ondelete='CASCADE'), nullable=False, index=True)
    sku = db.Column(db.String(64), nullable=False, index=True)
    item_name = db.Column(db.String(120), nullable=False)
    quantity = db.Column(db.Integer, default=1, nullable=False)
    unit_price = db.Column(db.Float, default=0.0, nullable=False)

    # Relationships
    order = db.relationship('CustomerOrder', back_populates='items')

    @property
    def line_total(self) -> float:
        return round(self.quantity * self.unit_price, 2)

    def __repr__(self) -> str:
        return f'<OrderItem {self.sku} x {self.quantity}>'
