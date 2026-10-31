from datetime import datetime, timezone
from sqlalchemy import CheckConstraint, UniqueConstraint
from app.extensions import db


class Supplier(db.Model):
    __tablename__ = 'suppliers'

    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(32), unique=True, nullable=False, index=True)
    name = db.Column(db.String(120), nullable=False)
    country = db.Column(db.String(64), nullable=True)
    city = db.Column(db.String(64), nullable=True)
    reliability_score = db.Column(db.Float, default=1.0, nullable=False)
    lead_time_days = db.Column(db.Integer, default=7, nullable=False)
    expected_supply_date = db.Column(db.DateTime, nullable=True)
    contact_email = db.Column(db.String(120), nullable=True)
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    # Relationships
    shipments = db.relationship('Shipment', back_populates='supplier', lazy='dynamic')

    @property
    def supplier_code(self) -> str:
        return self.code

    def __repr__(self) -> str:
        return f'<Supplier {self.code} - {self.name}>'


class Warehouse(db.Model):
    __tablename__ = 'warehouses'

    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(32), unique=True, nullable=False, index=True)
    name = db.Column(db.String(120), nullable=False)
    location = db.Column(db.String(120), nullable=True)
    capacity_sqm = db.Column(db.Float, default=0.0, nullable=False)
    current_utilization = db.Column(db.Float, default=0.0, nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    # Relationships
    inventories = db.relationship('Inventory', back_populates='warehouse', cascade='all, delete-orphan', lazy='dynamic')
    origin_shipments = db.relationship(
        'Shipment',
        foreign_keys='Shipment.origin_warehouse_id',
        back_populates='origin_warehouse',
        lazy='dynamic'
    )
    destination_shipments = db.relationship(
        'Shipment',
        foreign_keys='Shipment.destination_warehouse_id',
        back_populates='destination_warehouse',
        lazy='dynamic'
    )

    @property
    def warehouse_code(self) -> str:
        return self.code

    def __repr__(self) -> str:
        return f'<Warehouse {self.code} - {self.name}>'


class Inventory(db.Model):
    __tablename__ = 'inventories'
    __table_args__ = (
        CheckConstraint('quantity >= 0', name='ck_inventory_quantity_non_negative'),
        CheckConstraint('reserved_quantity >= 0', name='ck_inventory_reserved_non_negative'),
        UniqueConstraint('warehouse_id', 'sku', name='uq_warehouse_sku'),
    )

    id = db.Column(db.Integer, primary_key=True)
    warehouse_id = db.Column(db.Integer, db.ForeignKey('warehouses.id', ondelete='CASCADE'), nullable=False, index=True)
    sku = db.Column(db.String(64), nullable=False, index=True)
    item_name = db.Column(db.String(120), nullable=False)
    category = db.Column(db.String(64), nullable=True)
    quantity = db.Column(db.Integer, default=0, nullable=False)
    reserved_quantity = db.Column(db.Integer, default=0, nullable=False)
    reorder_point = db.Column(db.Integer, default=10, nullable=False)
    unit_cost = db.Column(db.Float, default=0.0, nullable=False)
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    # Relationships
    warehouse = db.relationship('Warehouse', back_populates='inventories')

    @property
    def available_quantity(self) -> int:
        return max(0, self.quantity - self.reserved_quantity)

    @property
    def is_low_stock(self) -> bool:
        return self.available_quantity <= self.reorder_point

    @property
    def quantity_on_hand(self) -> int:
        return self.quantity

    @quantity_on_hand.setter
    def quantity_on_hand(self, val: int) -> None:
        self.quantity = val

    @property
    def safety_stock(self) -> int:
        return self.reorder_point

    @safety_stock.setter
    def safety_stock(self, val: int) -> None:
        self.reorder_point = val

    @property
    def quantity_reserved(self) -> int:
        return self.reserved_quantity

    @quantity_reserved.setter
    def quantity_reserved(self, val: int) -> None:
        self.reserved_quantity = val

    def __repr__(self) -> str:
        return f'<Inventory {self.sku} @ WH {self.warehouse_id}: {self.quantity}>'


class Shipment(db.Model):
    __tablename__ = 'shipments'

    id = db.Column(db.Integer, primary_key=True)
    tracking_number = db.Column(db.String(64), unique=True, nullable=False, index=True)
    supplier_id = db.Column(db.Integer, db.ForeignKey('suppliers.id'), nullable=True, index=True)
    origin_warehouse_id = db.Column(db.Integer, db.ForeignKey('warehouses.id'), nullable=True, index=True)
    destination_warehouse_id = db.Column(db.Integer, db.ForeignKey('warehouses.id'), nullable=True, index=True)
    
    carrier = db.Column(db.String(64), nullable=True)
    transport_mode = db.Column(db.String(32), default='Ocean', nullable=False)  # Ocean, Air, Road, Rail
    status = db.Column(db.String(32), default='In Transit', nullable=False)     # Scheduled, In Transit, Delayed, Delivered, Cancelled
    origin_city = db.Column(db.String(64), nullable=True)
    destination_city = db.Column(db.String(64), nullable=True)
    
    estimated_departure = db.Column(db.DateTime, nullable=True)
    actual_departure = db.Column(db.DateTime, nullable=True)
    estimated_arrival = db.Column(db.DateTime, nullable=True)
    actual_arrival = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    # Relationships
    supplier = db.relationship('Supplier', back_populates='shipments')
    origin_warehouse = db.relationship('Warehouse', foreign_keys=[origin_warehouse_id], back_populates='origin_shipments')
    destination_warehouse = db.relationship('Warehouse', foreign_keys=[destination_warehouse_id], back_populates='destination_shipments')
    disruptions = db.relationship('Disruption', back_populates='shipment', lazy='dynamic')
    items = db.relationship('ShipmentItem', back_populates='shipment', cascade='all, delete-orphan', lazy='dynamic')

    def __repr__(self) -> str:
        return f'<Shipment {self.tracking_number} ({self.status})>'


class ShipmentItem(db.Model):
    __tablename__ = 'shipment_items'
    __table_args__ = (
        CheckConstraint('quantity > 0', name='ck_shipment_item_quantity_positive'),
    )

    id = db.Column(db.Integer, primary_key=True)
    shipment_id = db.Column(db.Integer, db.ForeignKey('shipments.id', ondelete='CASCADE'), nullable=False, index=True)
    sku = db.Column(db.String(64), nullable=False, index=True)
    item_name = db.Column(db.String(120), nullable=False)
    quantity = db.Column(db.Integer, default=1, nullable=False)

    # Relationships
    shipment = db.relationship('Shipment', back_populates='items')

    def __repr__(self) -> str:
        return f'<ShipmentItem {self.sku} x {self.quantity} in Shipment {self.shipment_id}>'
