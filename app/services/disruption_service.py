from datetime import datetime, timezone
from app.extensions import db
from app.models.logistics import Shipment, Inventory, Warehouse
from app.models.orders import CustomerOrder, OrderItem
from app.models.disruptions import Disruption
from app.services.audit_service import record_audit


def to_utc(dt):
    """Safely converts a datetime object to timezone-aware UTC datetime."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def evaluate_and_record_shipment_disruption(shipment: Shipment, delay_hours: int = 0, reason: str = None) -> Disruption:
    """
    Evaluates a shipment for disruption.
    Links the disruption to the shipment and any downstream customer orders whose delivery
    depends on the delayed cargo at the destination warehouse.
    """
    now = datetime.now(timezone.utc)
    if delay_hours <= 0 and shipment.estimated_arrival and shipment.actual_arrival is None:
        est_arrival = to_utc(shipment.estimated_arrival)
        if est_arrival < now:
            diff = now - est_arrival
            delay_hours = max(24, int(diff.total_seconds() // 3600))
        else:
            delay_hours = 48  # Default flagged delay

    # 1. Locate or create disruption record
    disruption = Disruption.query.filter_by(shipment_id=shipment.id, status='Active').first()
    if not disruption:
        dis_code = f"DIS-{shipment.tracking_number}"
        disruption = Disruption.query.filter_by(disruption_code=dis_code).first()

    title = f"Transit Delay — {shipment.carrier or 'Carrier'} ({shipment.tracking_number})"
    desc = reason or f"Shipment {shipment.tracking_number} delayed by {delay_hours} hours en route to {shipment.destination_city or 'destination'}."

    if not disruption:
        disruption = Disruption(
            disruption_code=f"DIS-{shipment.tracking_number}",
            title=title,
            disruption_type='Carrier Delay',
            severity='High',
            status='Active',
            shortage_category='Potential Shortage',
            shipment_id=shipment.id,
            warehouse_id=shipment.destination_warehouse_id,
            location=shipment.destination_city or 'In Transit',
            description=desc,
            estimated_delay_hours=delay_hours,
            detected_at=now,
        )
        db.session.add(disruption)
        db.session.flush()
    else:
        disruption.title = title
        disruption.description = desc
        disruption.estimated_delay_hours = delay_hours
        disruption.status = 'Active'

    # 2. Update shipment status
    shipment.status = 'Delayed'

    # 3. Trace cargo SKUs to downstream customer orders at destination warehouse
    shipment_skus = [item.sku for item in shipment.items.all()]

    if shipment.destination_warehouse_id and shipment_skus:
        # Find customer orders assigned to destination warehouse requiring any of these SKUs
        candidate_orders = CustomerOrder.query.filter(
            CustomerOrder.assigned_warehouse_id == shipment.destination_warehouse_id,
            CustomerOrder.status.in_(['Pending', 'Allocated', 'At Risk'])
        ).all()

        affected_count = 0
        for ord_obj in candidate_orders:
            # Check if this order contains any of the delayed SKUs
            matching_skus = [oi.sku for oi in ord_obj.items.all() if oi.sku in shipment_skus]
            if matching_skus:
                # Check destination warehouse inventory availability
                for sku in matching_skus:
                    inv = Inventory.query.filter_by(
                        warehouse_id=shipment.destination_warehouse_id,
                        sku=sku
                    ).first()
                    # If local inventory available stock is low, the order is at risk
                    if not inv or inv.available_quantity < 50:
                        ord_obj.status = 'At Risk'
                        if ord_obj not in disruption.affected_orders:
                            disruption.affected_orders.append(ord_obj)
                            affected_count += 1

        if affected_count > 0:
            disruption.severity = 'Critical'
            disruption.shortage_category = 'Potential Shortage'

    db.session.commit()
    return disruption


def detect_warehouse_inventory_shortages() -> list:
    """
    Scans all warehouses for critical stockouts and compares available inventory against
    total customer order demand. Creates Confirmed Shortage disruptions where on-hand stock
    cannot satisfy commitments.
    """
    now = datetime.now(timezone.utc)
    new_disruptions = []

    warehouses = Warehouse.query.all()
    for wh in warehouses:
        inventories = Inventory.query.filter_by(warehouse_id=wh.id).all()
        for inv in inventories:
            # Calculate total customer order demand for this SKU at this warehouse
            pending_orders = CustomerOrder.query.filter(
                CustomerOrder.assigned_warehouse_id == wh.id,
                CustomerOrder.status.in_(['Pending', 'Allocated', 'At Risk'])
            ).all()

            sku_demand = 0
            demanding_orders = []
            for co in pending_orders:
                for oi in co.items.all():
                    if oi.sku == inv.sku:
                        sku_demand += oi.quantity
                        demanding_orders.append(co)

            # If demand exceeds available stock, we have a shortage!
            if sku_demand > inv.available_quantity and sku_demand > 0:
                # Check if an active disruption already exists for this warehouse & SKU
                dis_code = f"DIS-{wh.code}-{inv.sku}"
                existing = Disruption.query.filter_by(disruption_code=dis_code, status='Active').first()

                # Determine if incoming stock is en route
                incoming_shipments = Shipment.query.filter(
                    Shipment.destination_warehouse_id == wh.id,
                    Shipment.status.in_(['In Transit', 'Delayed', 'Scheduled'])
                ).all()

                has_inbound = any(
                    any(it.sku == inv.sku for it in s.items.all())
                    for s in incoming_shipments
                )

                shortage_type = 'Potential Shortage' if has_inbound else 'Confirmed Shortage'
                deficit = sku_demand - inv.available_quantity

                if not existing:
                    disruption = Disruption(
                        disruption_code=dis_code,
                        title=f"{wh.code} Inventory Shortage — {inv.item_name} ({inv.sku})",
                        disruption_type='Warehouse Stockout',
                        severity='Critical' if shortage_type == 'Confirmed Shortage' else 'High',
                        status='Active',
                        shortage_category=shortage_type,
                        warehouse_id=wh.id,
                        location=f"{wh.name} ({wh.location})",
                        description=(
                            f"Deficit of {deficit} units for {inv.item_name} ({inv.sku}) at {wh.code}. "
                            f"Total customer demand is {sku_demand} units, but only {inv.available_quantity} available in stock. "
                            f"{'Incoming shipment delayed or scheduled.' if has_inbound else 'No incoming shipments registered.'}"
                        ),
                        estimated_delay_hours=48,
                        detected_at=now,
                    )
                    db.session.add(disruption)
                    db.session.flush()

                    for ord_obj in demanding_orders:
                        ord_obj.status = 'At Risk'
                        if ord_obj not in disruption.affected_orders:
                            disruption.affected_orders.append(ord_obj)

                    new_disruptions.append(disruption)
                else:
                    # Update existing shortage
                    existing.shortage_category = shortage_type
                    existing.description = (
                        f"Deficit of {deficit} units for {inv.item_name} ({inv.sku}) at {wh.code}. "
                        f"Demand: {sku_demand}, Available: {inv.available_quantity}."
                    )
                    for ord_obj in demanding_orders:
                        ord_obj.status = 'At Risk'
                        if ord_obj not in existing.affected_orders:
                            existing.affected_orders.append(ord_obj)

    db.session.commit()
    return new_disruptions


def run_full_disruption_scan() -> dict:
    """
    Executes an end-to-end scan across all shipments and warehouses,
    updating disruption records and logging an audit entry.
    """
    now = datetime.now(timezone.utc)
    # 1. Scan delayed shipments
    delayed_shipments = []
    for shp in Shipment.query.filter(Shipment.status.in_(['Delayed', 'In Transit'])).all():
        is_delayed = (
            shp.status == 'Delayed' or
            (shp.estimated_arrival and to_utc(shp.estimated_arrival) < now)
        )
        if is_delayed:
            evaluate_and_record_shipment_disruption(shp)
            delayed_shipments.append(shp)

    # 2. Scan warehouse inventory shortages
    shortages = detect_warehouse_inventory_shortages()

    # 3. Aggregation metrics
    active_disruptions = Disruption.query.filter_by(status='Active').count()
    potential_shortages = Disruption.query.filter_by(status='Active', shortage_category='Potential Shortage').count()
    confirmed_shortages = Disruption.query.filter_by(status='Active', shortage_category='Confirmed Shortage').count()
    affected_orders = CustomerOrder.query.filter_by(status='At Risk').count()

    summary = {
        'delayed_shipments_evaluated': len(delayed_shipments),
        'warehouse_shortages_evaluated': len(shortages),
        'active_disruptions_count': active_disruptions,
        'active_disruptions': active_disruptions,
        'potential_shortages': potential_shortages,
        'confirmed_shortages': confirmed_shortages,
        'affected_orders': affected_orders,
        'timestamp': now.isoformat()
    }

    record_audit(
        action='DISRUPTION_SCAN',
        entity_type='DisruptionEngine',
        details=f"Full disruption telemetry scan completed: {summary}"
    )

    return summary
