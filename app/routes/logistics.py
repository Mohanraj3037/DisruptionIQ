from datetime import datetime, timezone
from flask import Blueprint, render_template, request
from flask_login import login_required
from app.models.logistics import Supplier, Warehouse, Inventory, Shipment
from app.models.orders import CustomerOrder
from app.models.disruptions import Disruption

logistics_bp = Blueprint('logistics', __name__)


@logistics_bp.route('/suppliers')
@login_required
def suppliers():
    search_q = request.args.get('q', '').strip()
    query = Supplier.query
    if search_q:
        query = query.filter(
            (Supplier.name.ilike(f'%{search_q}%')) |
            (Supplier.code.ilike(f'%{search_q}%')) |
            (Supplier.country.ilike(f'%{search_q}%'))
        )
    suppliers_list = query.order_by(Supplier.code).all()
    return render_template('logistics/suppliers.html', suppliers=suppliers_list, search_q=search_q)


@logistics_bp.route('/warehouses')
@login_required
def warehouses():
    warehouses_list = Warehouse.query.order_by(Warehouse.code).all()
    # Compute live stats per warehouse
    stats = {}
    for wh in warehouses_list:
        sku_count = wh.inventories.count()
        total_units = sum(i.quantity for i in wh.inventories.all())
        total_value = sum(i.quantity * i.unit_cost for i in wh.inventories.all())
        active_incoming = Shipment.query.filter(
            Shipment.destination_warehouse_id == wh.id,
            Shipment.status.in_(['In Transit', 'Delayed', 'Scheduled'])
        ).count()
        stats[wh.id] = {
            'sku_count': sku_count,
            'total_units': total_units,
            'total_value': round(total_value, 2),
            'active_incoming': active_incoming,
        }
    return render_template('logistics/warehouses.html', warehouses=warehouses_list, stats=stats)


@logistics_bp.route('/shipments')
@login_required
def shipments():
    status_filter = request.args.get('status', 'all').strip()
    search_q = request.args.get('q', '').strip()

    query = Shipment.query

    if status_filter and status_filter.lower() != 'all':
        # Normalize status matching
        status_map = {
            'in_transit': 'In Transit',
            'delayed': 'Delayed',
            'scheduled': 'Scheduled',
            'delivered': 'Delivered',
            'cancelled': 'Cancelled'
        }
        target_status = status_map.get(status_filter.lower(), status_filter.title())
        query = query.filter_by(status=target_status)

    if search_q:
        query = query.filter(
            (Shipment.tracking_number.ilike(f'%{search_q}%')) |
            (Shipment.carrier.ilike(f'%{search_q}%')) |
            (Shipment.origin_city.ilike(f'%{search_q}%')) |
            (Shipment.destination_city.ilike(f'%{search_q}%'))
        )

    shipments_list = query.order_by(Shipment.created_at.desc()).all()
    
    counts = {
        'all': Shipment.query.count(),
        'in_transit': Shipment.query.filter_by(status='In Transit').count(),
        'delayed': Shipment.query.filter_by(status='Delayed').count(),
        'scheduled': Shipment.query.filter_by(status='Scheduled').count(),
        'delivered': Shipment.query.filter_by(status='Delivered').count(),
    }

    return render_template(
        'logistics/shipments.html',
        shipments=shipments_list,
        current_status=status_filter,
        search_q=search_q,
        counts=counts
    )


@logistics_bp.route('/inventory')
@login_required
def inventory():
    wh_filter = request.args.get('warehouse', 'all').strip()
    low_stock_only = request.args.get('low_stock', '').lower() == 'true'
    search_q = request.args.get('q', '').strip()

    query = Inventory.query

    if wh_filter and wh_filter.lower() != 'all':
        wh = Warehouse.query.filter_by(code=wh_filter).first()
        if wh:
            query = query.filter_by(warehouse_id=wh.id)

    if low_stock_only:
        query = query.filter((Inventory.quantity - Inventory.reserved_quantity) <= Inventory.reorder_point)

    if search_q:
        query = query.filter(
            (Inventory.sku.ilike(f'%{search_q}%')) |
            (Inventory.item_name.ilike(f'%{search_q}%')) |
            (Inventory.category.ilike(f'%{search_q}%'))
        )

    inventories_list = query.order_by(Inventory.sku).all()
    all_warehouses = Warehouse.query.order_by(Warehouse.code).all()

    total_skus = Inventory.query.count()
    low_stock_count = Inventory.query.filter((Inventory.quantity - Inventory.reserved_quantity) <= Inventory.reorder_point).count()

    return render_template(
        'logistics/inventory.html',
        inventories=inventories_list,
        warehouses=all_warehouses,
        current_wh=wh_filter,
        low_stock_only=low_stock_only,
        search_q=search_q,
        total_skus=total_skus,
        low_stock_count=low_stock_count
    )


@logistics_bp.route('/orders')
@login_required
def orders():
    tier_filter = request.args.get('tier', 'all').strip()
    priority_filter = request.args.get('priority', 'all').strip()
    search_q = request.args.get('q', '').strip()

    query = CustomerOrder.query

    if tier_filter and tier_filter.lower() != 'all':
        query = query.filter_by(customer_tier=tier_filter.title())

    if priority_filter and priority_filter.lower() != 'all':
        query = query.filter_by(priority=priority_filter.title())

    if search_q:
        query = query.filter(
            (CustomerOrder.order_number.ilike(f'%{search_q}%')) |
            (CustomerOrder.customer_name.ilike(f'%{search_q}%'))
        )

    orders_list = query.order_by(CustomerOrder.order_date.desc()).all()

    counts = {
        'total': CustomerOrder.query.count(),
        'at_risk': CustomerOrder.query.filter_by(status='At Risk').count(),
        'platinum': CustomerOrder.query.filter_by(customer_tier='Platinum').count(),
        'critical': CustomerOrder.query.filter_by(priority='Critical').count(),
    }

    return render_template(
        'logistics/orders.html',
        orders=orders_list,
        current_tier=tier_filter,
        current_priority=priority_filter,
        search_q=search_q,
        counts=counts
    )


@logistics_bp.route('/disruptions')
@login_required
def disruptions():
    severity_filter = request.args.get('severity', 'all').strip()
    status_filter = request.args.get('status', 'all').strip()

    query = Disruption.query

    if severity_filter and severity_filter.lower() != 'all':
        query = query.filter_by(severity=severity_filter.title())

    if status_filter and status_filter.lower() != 'all':
        query = query.filter_by(status=status_filter.title())

    disruptions_list = query.order_by(Disruption.detected_at.desc()).all()

    counts = {
        'total': Disruption.query.count(),
        'active': Disruption.query.filter_by(status='Active').count(),
        'critical': Disruption.query.filter_by(severity='Critical').count(),
        'potential_shortages': Disruption.query.filter_by(shortage_category='Potential Shortage').count(),
        'confirmed_shortages': Disruption.query.filter_by(shortage_category='Confirmed Shortage').count(),
    }

    return render_template(
        'logistics/disruptions.html',
        disruptions=disruptions_list,
        current_severity=severity_filter,
        current_status=status_filter,
        counts=counts
    )


from app.services.impact_analysis_service import analyze_disruption_impact
from app.services.risk_scoring_service import calculate_order_risk

@logistics_bp.route('/disruptions/<int:disruption_id>')
@login_required
def disruption_detail(disruption_id: int):
    disruption = Disruption.query.get_or_404(disruption_id)
    impact_analysis = analyze_disruption_impact(disruption_id)
    affected_orders = disruption.affected_orders.all()

    order_risks = []
    for ord_obj in affected_orders:
        scored = calculate_order_risk(ord_obj, disruption, impact_analysis.get('affected_skus'))
        order_risks.append(scored)

    order_risks.sort(key=lambda x: -x['final_risk_score'])

    return render_template(
        'logistics/disruption_detail.html',
        disruption=disruption,
        affected_orders=affected_orders,
        impact_analysis=impact_analysis,
        order_risks=order_risks
    )

