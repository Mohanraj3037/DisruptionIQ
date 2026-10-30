"""
DisruptionIQ — Supply-Chain Impact Analysis Service
Analyses the end-to-end propagation chain:
Supplier → Shipment → Destination Warehouse → SKU/Inventory → Customer Orders.

Deterministic, read-only analysis. Never modifies inventory or executes recovery actions.
"""

from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
from app.extensions import db
from app.models.disruptions import Disruption
from app.models.logistics import Shipment, Warehouse, Inventory, Supplier, ShipmentItem
from app.models.orders import CustomerOrder, OrderItem


def to_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Safely converts a datetime object to timezone-aware UTC datetime."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def analyze_disruption_impact(disruption_id: int) -> Dict[str, Any]:
    """
    Performs comprehensive impact chain analysis for a specific disruption.
    Returns structured metrics across Supplier, Shipment, Warehouse, Inventory,
    and Customer Orders without modifying database state.
    """
    disruption = db.session.get(Disruption, disruption_id)
    if not disruption:
        return {
            'error': f'Disruption with ID {disruption_id} not found.',
            'disruption_id': disruption_id
        }

    now = datetime.now(timezone.utc)

    # 1. Disruption Metadata
    disruption_meta = {
        'id': disruption.id,
        'disruption_code': disruption.disruption_code,
        'title': disruption.title,
        'disruption_type': disruption.disruption_type,
        'status': disruption.status,
        'severity': disruption.severity,
        'shortage_category': disruption.shortage_category,
        'location': disruption.location or 'Unknown',
        'description': disruption.description or 'No description provided.',
        'estimated_delay_hours': disruption.estimated_delay_hours or 0,
        'detected_at': disruption.detected_at.isoformat() if disruption.detected_at else None,
    }

    # 2. Linked Shipment & Supplier
    shipment_info = None
    supplier_info = None
    affected_skus = set()

    if disruption.shipment:
        shp = disruption.shipment
        shipment_info = {
            'id': shp.id,
            'tracking_number': shp.tracking_number,
            'carrier': shp.carrier or 'Unknown Carrier',
            'transport_mode': shp.transport_mode or 'Unknown',
            'status': shp.status,
            'origin_city': shp.origin_city or 'Unknown Origin',
            'destination_city': shp.destination_city or 'Unknown Destination',
            'estimated_departure': shp.estimated_departure.isoformat() if shp.estimated_departure else None,
            'actual_departure': shp.actual_departure.isoformat() if shp.actual_departure else None,
            'estimated_arrival': shp.estimated_arrival.isoformat() if shp.estimated_arrival else None,
            'actual_arrival': shp.actual_arrival.isoformat() if shp.actual_arrival else None,
            'is_delayed': shp.status == 'Delayed',
            'cargo_items': []
        }
        for item in shp.items.all():
            shipment_info['cargo_items'].append({
                'sku': item.sku,
                'item_name': item.item_name,
                'quantity': item.quantity
            })
            affected_skus.add(item.sku)

        if shp.supplier:
            sup = shp.supplier
            supplier_info = {
                'id': sup.id,
                'code': sup.code,
                'name': sup.name,
                'country': sup.country or 'Unknown',
                'city': sup.city or 'Unknown',
                'reliability_score': sup.reliability_score,
                'lead_time_days': sup.lead_time_days,
                'expected_supply_date': sup.expected_supply_date.isoformat() if sup.expected_supply_date else None,
            }

    # If disruption doesn't link to a shipment directly, check its description or warehouse for SKUs
    destination_wh = disruption.warehouse or (disruption.shipment.destination_warehouse if disruption.shipment else None)

    # 3. Destination Warehouse Information
    warehouse_info = None
    if destination_wh:
        warehouse_info = {
            'id': destination_wh.id,
            'code': destination_wh.code,
            'name': destination_wh.name,
            'location': destination_wh.location,
            'capacity_sqm': destination_wh.capacity_sqm,
            'current_utilization': destination_wh.current_utilization,
        }

    # Extract SKUs from linked affected orders if not yet identified
    affected_orders_list = disruption.affected_orders.all()
    for ord_obj in affected_orders_list:
        for oi in ord_obj.items.all():
            if not affected_skus or oi.sku in affected_skus:
                affected_skus.add(oi.sku)

    # If still empty (e.g. text-only description like SKU-SNS-02)
    if not affected_skus and disruption.warehouse:
        # Check SKUs in description
        for inv in disruption.warehouse.inventories.all():
            if inv.sku in disruption.title or inv.sku in (disruption.description or ''):
                affected_skus.add(inv.sku)

    # 4. Inventory Balances at Destination Warehouse
    inventory_metrics = {}
    incoming_supply = []
    alternative_warehouses = []

    if destination_wh:
        # Check inventory for all identified affected SKUs
        for sku in sorted(list(affected_skus)):
            inv = Inventory.query.filter_by(warehouse_id=destination_wh.id, sku=sku).first()
            if inv:
                inventory_metrics[sku] = {
                    'sku': inv.sku,
                    'item_name': inv.item_name,
                    'category': inv.category,
                    'quantity_on_hand': inv.quantity,
                    'reserved_quantity': inv.reserved_quantity,
                    'available_quantity': inv.available_quantity,
                    'reorder_point': inv.reorder_point,
                    'unit_cost': inv.unit_cost,
                    'is_low_stock': inv.is_low_stock,
                }
            else:
                inventory_metrics[sku] = {
                    'sku': sku,
                    'item_name': 'Unknown / Unstocked SKU',
                    'category': 'Unknown',
                    'quantity_on_hand': 0,
                    'reserved_quantity': 0,
                    'available_quantity': 0,
                    'reorder_point': 0,
                    'unit_cost': 0.0,
                    'is_low_stock': True,
                }

            # Check inbound shipments to this destination warehouse for this SKU
            inbound_query = Shipment.query.filter(
                Shipment.destination_warehouse_id == destination_wh.id,
                Shipment.status.in_(['In Transit', 'Delayed', 'Scheduled'])
            ).all()

            for in_shp in inbound_query:
                matching_items = [it for it in in_shp.items.all() if it.sku == sku]
                for mit in matching_items:
                    incoming_supply.append({
                        'shipment_id': in_shp.id,
                        'tracking_number': in_shp.tracking_number,
                        'carrier': in_shp.carrier,
                        'sku': mit.sku,
                        'quantity': mit.quantity,
                        'status': in_shp.status,
                        'estimated_arrival': in_shp.estimated_arrival.isoformat() if in_shp.estimated_arrival else 'Unknown',
                        'is_delayed': in_shp.status == 'Delayed'
                    })

            # Check Alternative Warehouses holding this SKU with surplus stock
            alt_inventories = Inventory.query.filter(
                Inventory.warehouse_id != destination_wh.id,
                Inventory.sku == sku
            ).all()

            for a_inv in alt_inventories:
                surplus = max(0, a_inv.available_quantity - a_inv.reorder_point)
                alternative_warehouses.append({
                    'warehouse_id': a_inv.warehouse.id,
                    'warehouse_code': a_inv.warehouse.code,
                    'warehouse_name': a_inv.warehouse.name,
                    'warehouse_location': a_inv.warehouse.location,
                    'sku': sku,
                    'item_name': a_inv.item_name,
                    'total_quantity': a_inv.quantity,
                    'reserved_quantity': a_inv.reserved_quantity,
                    'available_quantity': a_inv.available_quantity,
                    'reorder_point': a_inv.reorder_point,
                    'surplus_available': surplus,
                    'can_transfer': surplus > 0
                })

    # 5. Customer Orders Demand and Shortage Analysis
    orders_analysis = []
    total_sku_demand = {sku: 0 for sku in affected_skus}

    for ord_obj in affected_orders_list:
        ord_deadline = to_utc(ord_obj.delivery_deadline)
        hours_to_deadline = None
        if ord_deadline:
            hours_to_deadline = round((ord_deadline - now).total_seconds() / 3600, 1)

        ord_items_details = []
        order_affected_qty = 0

        for oi in ord_obj.items.all():
            is_affected = oi.sku in affected_skus
            if is_affected:
                total_sku_demand[oi.sku] = total_sku_demand.get(oi.sku, 0) + oi.quantity
                order_affected_qty += oi.quantity

            ord_items_details.append({
                'sku': oi.sku,
                'item_name': oi.item_name,
                'quantity': oi.quantity,
                'unit_price': oi.unit_price,
                'line_total': oi.line_total,
                'is_affected': is_affected
            })

        orders_analysis.append({
            'id': ord_obj.id,
            'order_number': ord_obj.order_number,
            'customer_name': ord_obj.customer_name,
            'customer_tier': ord_obj.customer_tier or 'Standard',
            'status': ord_obj.status,
            'priority': ord_obj.priority or 'Medium',
            'assigned_warehouse_code': ord_obj.assigned_warehouse.code if ord_obj.assigned_warehouse else 'Unassigned',
            'delivery_deadline': ord_obj.delivery_deadline.isoformat() if ord_obj.delivery_deadline else None,
            'hours_to_deadline': hours_to_deadline,
            'total_amount': ord_obj.total_amount,
            'affected_quantity': order_affected_qty,
            'items': ord_items_details,
        })

    # 6. Quantify Confirmed Shortage vs Potential Shortage
    shortage_metrics = {}
    for sku, demand in total_sku_demand.items():
        avail = inventory_metrics.get(sku, {}).get('available_quantity', 0)
        on_time_inbound = sum(
            s['quantity'] for s in incoming_supply
            if s['sku'] == sku and s['status'] in ['In Transit', 'Scheduled']
        )
        delayed_inbound = sum(
            s['quantity'] for s in incoming_supply
            if s['sku'] == sku and s['status'] == 'Delayed'
        )

        # Confirmed Shortage: Demand exceeds current available stock AND there is no on-time inbound supply
        confirmed_shortage = max(0, demand - avail - on_time_inbound)

        # Potential Shortage: Inbound supply is delayed in transit and order fulfillment depends on it
        potential_shortage = 0
        if delayed_inbound > 0 and (demand > avail):
            potential_shortage = min(demand - avail, delayed_inbound)

        shortage_metrics[sku] = {
            'total_demand': demand,
            'available_inventory': avail,
            'on_time_inbound': on_time_inbound,
            'delayed_inbound': delayed_inbound,
            'confirmed_shortage': confirmed_shortage,
            'potential_shortage': potential_shortage,
            'is_confirmed_deficit': confirmed_shortage > 0,
            'is_potential_deficit': potential_shortage > 0 and confirmed_shortage == 0,
        }

    # 7. Synthesis Narrative
    wh_code = warehouse_info['code'] if warehouse_info else 'destination hub'
    sku_list_str = ', '.join(affected_skus) if affected_skus else 'specified cargo'
    
    if disruption.shortage_category == 'Confirmed Shortage':
        narrative = (
            f"Confirmed Stockout at {wh_code}: Customer demand for {sku_list_str} exceeds current on-hand "
            f"available inventory with zero on-time inbound replenishment. {len(affected_orders_list)} customer orders "
            f"cannot be fulfilled without immediate cross-warehouse stock transfer or emergency supply."
        )
    elif disruption.shortage_category == 'Potential Shortage':
        delay_str = f"+{disruption.estimated_delay_hours}h" if disruption.estimated_delay_hours else "delayed"
        narrative = (
            f"Potential Transit Shortage: Inbound cargo for {sku_list_str} is delayed by {delay_str} en route "
            f"to {wh_code}. On-hand inventory is insufficient to cover commitments without this inbound replenishment. "
            f"{len(affected_orders_list)} customer orders face delivery deadline SLA breaches."
        )
    else:
        narrative = (
            f"Operational Disruption at {disruption.location or 'network node'}: "
            f"Affecting {len(affected_orders_list)} customer orders and incoming logistics flow."
        )

    return {
        'disruption': disruption_meta,
        'supplier': supplier_info,
        'shipment': shipment_info,
        'warehouse': warehouse_info,
        'affected_skus': sorted(list(affected_skus)),
        'inventory_balances': inventory_metrics,
        'incoming_supply': incoming_supply,
        'alternative_warehouses': alternative_warehouses,
        'shortage_metrics': shortage_metrics,
        'orders_affected': orders_analysis,
        'total_affected_orders_count': len(orders_analysis),
        'narrative_explanation': narrative,
        'analyzed_at': now.isoformat()
    }


def analyze_all_active_disruptions() -> List[Dict[str, Any]]:
    """Runs impact analysis for all active or investigating disruptions in the system."""
    active_disruptions = Disruption.query.filter(
        Disruption.status.in_(['Active', 'Investigating'])
    ).order_by(Disruption.detected_at.desc()).all()

    return [analyze_disruption_impact(d.id) for d in active_disruptions]
