"""
DisruptionIQ — Deterministic Order Risk Scoring Service
Calculates explainable, deterministic supply-chain risk scores for customer orders
affected by logistics disruptions.

Risk Score Formula:
  Risk Score = 0.35 × Deadline Risk + 0.30 × Shortage Risk + 0.20 × Customer Priority + 0.15 × Recovery Difficulty

Severity Classification Bands:
  • Critical: 80.00 – 100.00
  • High:     60.00 – 79.99
  • Medium:   30.00 – 59.99
  • Low:       0.00 – 29.99

Deterministic, read-only evaluation. Scores are calculated dynamically from active
database records and never modify inventory or execute automated recovery plans.
"""

from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
from app.extensions import db
from app.models.orders import CustomerOrder, OrderItem
from app.models.disruptions import Disruption
from app.models.logistics import Shipment, Warehouse, Inventory, Supplier


# Configurable weights and severity bands
RISK_SCORING_CONFIG = {
    'version': '1.0-deterministic',
    'weights': {
        'deadline_risk': 0.35,
        'shortage_risk': 0.30,
        'customer_priority': 0.20,
        'recovery_difficulty': 0.15,
    },
    'severity_bands': {
        'Critical': (80.00, 100.00),
        'High': (60.00, 79.99),
        'Medium': (30.00, 59.99),
        'Low': (0.00, 29.99),
    },
    'priority_scores': {
        'Critical': 90.0,
        'High': 70.0,
        'Medium': 40.0,
        'Normal': 40.0,
        'Low': 15.0,
    },
    'tier_modifiers': {
        'Platinum': 10.0,
        'Gold': 5.0,
        'Silver': 2.0,
        'Standard': 0.0,
    }
}


def to_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Safely converts a datetime object to timezone-aware UTC datetime."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def classify_severity(score: float) -> str:
    """Classifies a numeric risk score into a standardized severity band."""
    if score >= 80.00:
        return 'Critical'
    elif score >= 60.00:
        return 'High'
    elif score >= 30.00:
        return 'Medium'
    else:
        return 'Low'


def calculate_deadline_risk(order: CustomerOrder, disruption: Disruption, now: datetime) -> Dict[str, Any]:
    """
    Component A: Deadline Risk (0.0 to 100.0, Weight: 35%)
    Evaluates the temporal relationship between promised delivery deadline,
    estimated disruption delay, and available time remaining.
    """
    delay_hours = disruption.estimated_delay_hours or (disruption.delay_hours if hasattr(disruption, 'delay_hours') else 0) or 0
    ord_deadline = to_utc(order.delivery_deadline)

    if not ord_deadline:
        # Missing delivery deadline: explicit deterministic penalty
        return {
            'score': 50.0,
            'evidence': 'Missing promised delivery deadline; baseline 50.0 uncertainty penalty applied.',
            'hours_until_deadline': None,
            'estimated_delay_hours': delay_hours,
            'is_overdue': False,
            'will_miss_deadline': False
        }

    hours_remaining = (ord_deadline - now).total_seconds() / 3600.0

    if hours_remaining <= 0:
        # Deadline has already passed
        return {
            'score': 100.0,
            'evidence': f"Delivery deadline passed {abs(hours_remaining):.1f}h ago. Order is actively overdue.",
            'hours_until_deadline': round(hours_remaining, 1),
            'estimated_delay_hours': delay_hours,
            'is_overdue': True,
            'will_miss_deadline': True
        }

    if delay_hours >= hours_remaining:
        # Delay exceeds the remaining window; delivery SLA is guaranteed to be breached
        gap = delay_hours - hours_remaining
        score = min(100.0, 85.0 + 15.0 * (gap / max(24.0, float(delay_hours))))
        return {
            'score': round(score, 2),
            'evidence': (
                f"Disruption delay ({delay_hours}h) exceeds remaining delivery window ({hours_remaining:.1f}h) "
                f"by {gap:.1f}h. SLA breach is imminent."
            ),
            'hours_until_deadline': round(hours_remaining, 1),
            'estimated_delay_hours': delay_hours,
            'is_overdue': False,
            'will_miss_deadline': True
        }
    else:
        # Buffer exists after absorbing delay
        buffer_hours = hours_remaining - delay_hours
        if buffer_hours < 24.0:
            # Tight buffer
            score = 65.0 + 15.0 * (1.0 - (buffer_hours / 24.0))
            evidence = (
                f"Tight delivery buffer ({buffer_hours:.1f}h remaining after {delay_hours}h delay). "
                f"High risk of subsequent fulfillment delay causing SLA breach."
            )
        elif buffer_hours < 72.0:
            # Moderate buffer
            score = 35.0 + 30.0 * (1.0 - ((buffer_hours - 24.0) / 48.0))
            evidence = (
                f"Moderate delivery buffer ({buffer_hours:.1f}h remaining after {delay_hours}h delay). "
                f"Order can absorb minor secondary schedule adjustments."
            )
        else:
            # Ample buffer
            score = max(5.0, 35.0 * (1.0 - min(1.0, (buffer_hours - 72.0) / 120.0)))
            evidence = (
                f"Ample delivery buffer ({buffer_hours:.1f}h remaining after {delay_hours}h delay). "
                f"Low probability of missed deadline."
            )

        return {
            'score': round(score, 2),
            'evidence': evidence,
            'hours_until_deadline': round(hours_remaining, 1),
            'estimated_delay_hours': delay_hours,
            'is_overdue': False,
            'will_miss_deadline': False
        }


def calculate_shortage_risk(order: CustomerOrder, disruption: Disruption, affected_skus: List[str]) -> Dict[str, Any]:
    """
    Component B: Shortage Risk (0.0 to 100.0, Weight: 30%)
    Compares customer order demand against currently available on-hand stock and dependable supply.
    Never treats reserved inventory as available.
    """
    target_wh_id = order.assigned_warehouse_id or disruption.warehouse_id
    if not target_wh_id and disruption.shipment:
        target_wh_id = disruption.shipment.destination_warehouse_id

    # Find the items in this order that match the disruption's affected SKUs
    order_items = order.items.all()
    matching_items = [it for it in order_items if not affected_skus or it.sku in affected_skus]

    if not matching_items:
        # Fallback to all items in order if specific SKUs are not isolated
        matching_items = order_items

    total_order_affected_qty = sum(it.quantity for it in matching_items)
    primary_sku = matching_items[0].sku if matching_items else 'Unknown'

    if not target_wh_id:
        return {
            'score': 60.0,
            'evidence': 'Unassigned fulfillment warehouse. Inventory availability cannot be confirmed.',
            'primary_sku': primary_sku,
            'order_quantity': total_order_affected_qty,
            'available_quantity': 0,
            'shortage_quantity': total_order_affected_qty,
            'is_confirmed_shortage': False
        }

    # Query destination warehouse inventory for the primary affected SKU
    inv = Inventory.query.filter_by(warehouse_id=target_wh_id, sku=primary_sku).first()
    avail_qty = inv.available_quantity if inv else 0
    on_hand_qty = inv.quantity if inv else 0
    reserved_qty = inv.reserved_quantity if inv else 0
    reorder_pt = inv.reorder_point if inv else 0

    if not inv or avail_qty <= 0:
        # Zero stock available on hand
        shortage = total_order_affected_qty
        score = 100.0
        evidence = (
            f"Zero available stock for {primary_sku} at destination warehouse "
            f"(Total on-hand: {on_hand_qty}, Reserved: {reserved_qty}). Deficit: {shortage} units."
        )
        is_confirmed = True
    elif total_order_affected_qty > avail_qty:
        # Immediate individual order deficit
        shortage = total_order_affected_qty - avail_qty
        deficit_ratio = shortage / max(1, total_order_affected_qty)
        score = min(100.0, 70.0 + 30.0 * deficit_ratio)
        evidence = (
            f"Insufficient available stock ({avail_qty} available vs {total_order_affected_qty} required). "
            f"Immediate shortfall of {shortage} units for {primary_sku}."
        )
        is_confirmed = True
    else:
        # On-hand available stock exceeds single order demand
        # Check total competing demand across other at-risk orders sharing this warehouse and SKU
        competing_orders = CustomerOrder.query.filter(
            CustomerOrder.assigned_warehouse_id == target_wh_id,
            CustomerOrder.status.in_(['Pending', 'Allocated', 'At Risk'])
        ).all()

        total_sku_demand = 0
        for co in competing_orders:
            for ci in co.items.all():
                if ci.sku == primary_sku:
                    total_sku_demand += ci.quantity

        shortage = 0
        is_confirmed = False

        if total_sku_demand > avail_qty:
            # Shared inventory competition deficit
            deficit = total_sku_demand - avail_qty
            competition_factor = min(1.0, deficit / max(1, total_sku_demand))
            score = 35.0 + 25.0 * competition_factor
            evidence = (
                f"Available stock ({avail_qty}) covers this single order ({total_order_affected_qty}), "
                f"but total customer demand ({total_sku_demand}) exceeds available inventory by {deficit} units."
            )
        elif avail_qty <= reorder_pt:
            # Below safety reorder point
            score = 25.0
            evidence = (
                f"Sufficient stock for order ({total_order_affected_qty} req / {avail_qty} avail), "
                f"but inventory is at/below safety threshold (reorder point: {reorder_pt})."
            )
        else:
            # Healthy stock balance
            score = 10.0
            evidence = (
                f"Healthy available inventory ({avail_qty} available vs {total_order_affected_qty} required; "
                f"reorder point: {reorder_pt})."
            )

    return {
        'score': round(score, 2),
        'evidence': evidence,
        'primary_sku': primary_sku,
        'order_quantity': total_order_affected_qty,
        'available_quantity': avail_qty,
        'shortage_quantity': shortage,
        'is_confirmed_shortage': is_confirmed
    }


def calculate_customer_priority_risk(order: CustomerOrder) -> Dict[str, Any]:
    """
    Component C: Customer Priority Risk (0.0 to 100.0, Weight: 20%)
    Maps order priority and customer commercial tier into an authoritative business penalty score.
    """
    priority = (order.priority or 'Medium').title()
    tier = (order.customer_tier or 'Standard').title()

    base_score = RISK_SCORING_CONFIG['priority_scores'].get(priority, 40.0)
    tier_mod = RISK_SCORING_CONFIG['tier_modifiers'].get(tier, 0.0)

    score = min(100.0, max(0.0, base_score + tier_mod))
    evidence = (
        f"Order Priority '{priority}' (Base: {base_score:.1f}) + "
        f"Customer Tier '{tier}' (+{tier_mod:.1f}) = {score:.1f}/100."
    )

    return {
        'score': round(score, 2),
        'evidence': evidence,
        'priority': priority,
        'customer_tier': tier,
        'base_score': base_score,
        'tier_modifier': tier_mod
    }


def calculate_recovery_difficulty_risk(
    order: CustomerOrder,
    disruption: Disruption,
    primary_sku: str,
    required_qty: int,
    now: datetime
) -> Dict[str, Any]:
    """
    Component D: Recovery Difficulty Risk (0.0 to 100.0, Weight: 15%)
    Evaluates alternative fulfillment feasibility, including cross-warehouse stock buffers
    and supplier replenishment lead times against remaining delivery deadlines.
    """
    target_wh_id = order.assigned_warehouse_id or disruption.warehouse_id
    ord_deadline = to_utc(order.delivery_deadline)
    hours_remaining = (ord_deadline - now).total_seconds() / 3600.0 if ord_deadline else 72.0

    # 1. Search for available surplus stock in alternative network warehouses
    alt_inventories = Inventory.query.filter(
        Inventory.warehouse_id != target_wh_id,
        Inventory.sku == primary_sku
    ).all()

    total_network_surplus = sum(max(0, inv.available_quantity - inv.reorder_point) for inv in alt_inventories)
    alt_wh_codes = [inv.warehouse.code for inv in alt_inventories if (inv.available_quantity - inv.reorder_point) > 0]

    if total_network_surplus >= required_qty and required_qty > 0:
        # Full transfer surplus exists in network!
        if hours_remaining < 36.0:
            # Transfer transit is tight
            score = 50.0
            evidence = (
                f"Surplus stock exists in network ({total_network_surplus} units across {', '.join(alt_wh_codes)}), "
                f"but remaining delivery window ({hours_remaining:.1f}h) makes inter-hub transit tight."
            )
        else:
            # Ample transit window
            score = 20.0
            evidence = (
                f"High mitigation feasibility: Alternative warehouse ({', '.join(alt_wh_codes)}) holds "
                f"{total_network_surplus} surplus units available for transfer before deadline."
            )
    elif total_network_surplus > 0:
        # Partial transfer stock
        score = 65.0
        evidence = (
            f"Partial network buffer: Alternative warehouses hold {total_network_surplus} surplus units, "
            f"which cannot fully cover required {required_qty} units. Split fulfillment or partial stock transfer required."
        )
    else:
        # Zero surplus stock anywhere in the warehouse network
        sup_lead_days = 10
        if disruption.shipment and disruption.shipment.supplier:
            sup_lead_days = disruption.shipment.supplier.lead_time_days or 10

        sup_lead_hours = sup_lead_days * 24.0

        if hours_remaining < sup_lead_hours:
            score = 95.0
            evidence = (
                f"Severe recovery obstacle: Zero network surplus stock for {primary_sku}. "
                f"Supplier replenishment lead time ({sup_lead_days} days) exceeds deadline ({hours_remaining:.1f}h)."
            )
        else:
            score = 75.0
            evidence = (
                f"High recovery difficulty: Zero warehouse surplus in network. Emergency supplier reorder required "
                f"(Supplier lead time: {sup_lead_days} days)."
            )

    return {
        'score': round(score, 2),
        'evidence': evidence,
        'alternative_surplus_units': total_network_surplus,
        'transfer_candidate_warehouses': alt_wh_codes
    }


def calculate_order_risk(
    order: CustomerOrder,
    disruption: Disruption,
    affected_skus: Optional[List[str]] = None,
    now: Optional[datetime] = None
) -> Dict[str, Any]:
    """
    Computes a complete, explainable deterministic risk score breakdown for a single customer order.
    Formula:
      Risk Score = 0.35 × Deadline + 0.30 × Shortage + 0.20 × Priority + 0.15 × Recovery
    """
    if now is None:
        now = datetime.now(timezone.utc)

    if affected_skus is None:
        # Extract affected SKUs from disruption cargo or description
        affected_skus = []
        if disruption.shipment:
            affected_skus = [it.sku for it in disruption.shipment.items.all()]
        if not affected_skus:
            # Fallback to items in order
            affected_skus = [it.sku for it in order.items.all()]

    # 1. Calculate Component Scores (0 to 100)
    c_deadline = calculate_deadline_risk(order, disruption, now)
    c_shortage = calculate_shortage_risk(order, disruption, affected_skus)
    c_priority = calculate_customer_priority_risk(order)
    c_recovery = calculate_recovery_difficulty_risk(
        order,
        disruption,
        c_shortage['primary_sku'],
        c_shortage['order_quantity'],
        now
    )

    # 2. Weighted Aggregation
    weights = RISK_SCORING_CONFIG['weights']
    contrib_deadline = c_deadline['score'] * weights['deadline_risk']
    contrib_shortage = c_shortage['score'] * weights['shortage_risk']
    contrib_priority = c_priority['score'] * weights['customer_priority']
    contrib_recovery = c_recovery['score'] * weights['recovery_difficulty']

    raw_total = contrib_deadline + contrib_shortage + contrib_priority + contrib_recovery
    final_score = round(max(0.00, min(100.00, raw_total)), 2)

    # 3. Severity Classification
    severity = classify_severity(final_score)

    # 4. Human-Readable Explanation
    explanation = (
        f"Order {order.order_number} ({order.customer_name}) assessed with {severity} risk ({final_score:.2f}/100). "
        f"Key drivers: {c_deadline['evidence']} | {c_shortage['evidence']}"
    )

    return {
        'order_id': order.id,
        'order_number': order.order_number,
        'customer_name': order.customer_name,
        'customer_tier': order.customer_tier,
        'order_priority': order.priority,
        'order_status': order.status,
        'delivery_deadline': order.delivery_deadline.isoformat() if order.delivery_deadline else None,
        'delivery_deadline_dt': to_utc(order.delivery_deadline),
        'disruption_id': disruption.id,
        'disruption_code': disruption.disruption_code,
        'disruption_title': disruption.title,
        'disruption_severity': disruption.severity,
        'affected_sku': c_shortage['primary_sku'],
        'required_quantity': c_shortage['order_quantity'],
        'available_quantity': c_shortage['available_quantity'],
        'shortage_quantity': c_shortage['shortage_quantity'],
        'estimated_delay_hours': disruption.estimated_delay_hours or 0,
        'final_risk_score': final_score,
        'severity': severity,
        'components': {
            'deadline_risk': {
                'score': c_deadline['score'],
                'weight': weights['deadline_risk'],
                'contribution': round(contrib_deadline, 2),
                'evidence': c_deadline['evidence'],
                'hours_until_deadline': c_deadline['hours_until_deadline']
            },
            'shortage_risk': {
                'score': c_shortage['score'],
                'weight': weights['shortage_risk'],
                'contribution': round(contrib_shortage, 2),
                'evidence': c_shortage['evidence'],
                'is_confirmed': c_shortage['is_confirmed_shortage']
            },
            'customer_priority': {
                'score': c_priority['score'],
                'weight': weights['customer_priority'],
                'contribution': round(contrib_priority, 2),
                'evidence': c_priority['evidence']
            },
            'recovery_difficulty': {
                'score': c_recovery['score'],
                'weight': weights['recovery_difficulty'],
                'contribution': round(contrib_recovery, 2),
                'evidence': c_recovery['evidence'],
                'alternative_surplus_units': c_recovery['alternative_surplus_units'],
                'transfer_warehouses': c_recovery['transfer_candidate_warehouses']
            }
        },
        'explanation': explanation,
        'calculated_at': now.isoformat()
    }


def score_and_rank_all_affected_orders(
    disruption_id: Optional[int] = None,
    severity_filter: Optional[str] = None,
    status_filter: Optional[str] = None,
    priority_filter: Optional[str] = None,
    search_q: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Evaluates and ranks all affected customer orders across active disruptions.
    Deterministic Sorting:
      1. final_risk_score DESC
      2. delivery_deadline ASC (earliest deadline first; None sorted last)
      3. order_number ASC
    """
    now = datetime.now(timezone.utc)
    evaluated_orders = []
    seen_order_disruption_pairs = set()

    # Query active disruptions
    disruption_query = Disruption.query.filter(Disruption.status.in_(['Active', 'Investigating']))
    if disruption_id:
        disruption_query = disruption_query.filter(Disruption.id == disruption_id)

    active_disruptions = disruption_query.all()

    for dis in active_disruptions:
        affected_orders = dis.affected_orders.all()
        affected_skus = []
        if dis.shipment:
            affected_skus = [it.sku for it in dis.shipment.items.all()]

        for ord_obj in affected_orders:
            pair_key = (ord_obj.id, dis.id)
            if pair_key in seen_order_disruption_pairs:
                continue
            seen_order_disruption_pairs.add(pair_key)

            scored = calculate_order_risk(ord_obj, dis, affected_skus, now)
            evaluated_orders.append(scored)

    # Apply Filters
    filtered = evaluated_orders

    if severity_filter and severity_filter.lower() != 'all':
        filtered = [o for o in filtered if o['severity'].lower() == severity_filter.lower()]

    if status_filter and status_filter.lower() != 'all':
        norm_status = status_filter.lower().replace('_', ' ')
        filtered = [o for o in filtered if o['order_status'].lower() == norm_status]

    if priority_filter and priority_filter.lower() != 'all':
        filtered = [o for o in filtered if o['order_priority'].lower() == priority_filter.lower()]

    if search_q:
        q_lower = search_q.lower()
        filtered = [
            o for o in filtered
            if (
                q_lower in o['order_number'].lower() or
                q_lower in o['customer_name'].lower() or
                q_lower in o['affected_sku'].lower()
            )
        ]

    # Deterministic Sorting Key:
    # 1. -final_risk_score (highest score first)
    # 2. delivery_deadline (earliest deadline first; None mapped to max datetime)
    # 3. order_number (ascending)
    max_dt = datetime(2999, 12, 31, 23, 59, 59, tzinfo=timezone.utc)

    def sort_key(item):
        deadline = item['delivery_deadline_dt'] or max_dt
        return (-item['final_risk_score'], deadline, item['order_number'])

    sorted_orders = sorted(filtered, key=sort_key)

    # Assign 1-indexed Rank
    for rank_idx, ord_dict in enumerate(sorted_orders, start=1):
        ord_dict['rank'] = rank_idx

    return sorted_orders
