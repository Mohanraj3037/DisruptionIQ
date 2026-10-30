"""
DisruptionIQ — Recovery Planning Service
Generates evidence-based candidate recovery options, side-by-side comparisons,
and formal recovery plans for supply-chain disruptions.

Supported Options:
  1. Inter-Warehouse Stock Transfer
  2. Alternative Supplier Expedited Order
  3. Shipment Rerouting / Expedited Freight
  4. Customer Order Reprioritisation
  5. Partial Fulfilment / Split Allocation

Deterministic, non-destructive recommendation generation.
"""

from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional
from app.extensions import db
from app.models.disruptions import Disruption, RecoveryPlan, RecoveryAction
from app.models.logistics import Warehouse, Inventory, Supplier, Shipment
from app.models.orders import CustomerOrder
from app.services.impact_analysis_service import analyze_disruption_impact
from app.services.risk_scoring_service import score_and_rank_all_affected_orders
from app.services.audit_service import record_audit
from app.services.notification_service import create_notification


def generate_recovery_recommendations(disruption_id: int) -> List[Dict[str, Any]]:
    """
    Analyzes an active disruption and generates all feasible candidate recovery options
    ranked deterministically by operational feasibility, risk reduction, time, and cost.
    Does NOT modify database records.
    """
    disruption = db.session.get(Disruption, disruption_id)
    if not disruption:
        return []

    impact = analyze_disruption_impact(disruption_id)
    affected_skus = impact.get('affected_skus', [])
    primary_sku = affected_skus[0] if affected_skus else 'SKU-UNKNOWN'
    
    dest_wh = disruption.warehouse or (disruption.shipment.destination_warehouse if disruption.shipment else None)
    dest_wh_id = dest_wh.id if dest_wh else None
    dest_wh_code = dest_wh.code if dest_wh else 'DEST-HUB'

    # Determine total affected demand and confirmed/potential deficit
    shortage_metrics = impact.get('shortage_metrics', {}).get(primary_sku, {})
    total_demand = shortage_metrics.get('total_demand', 0)
    avail_qty = shortage_metrics.get('available_inventory', 0)
    confirmed_deficit = shortage_metrics.get('confirmed_shortage', 0)
    potential_deficit = shortage_metrics.get('potential_shortage', 0)
    deficit_qty = confirmed_deficit or potential_deficit or max(0, total_demand - avail_qty) or total_demand or 50

    candidate_options = []

    # =========================================================================
    # OPTION 1: Inter-Warehouse Stock Transfer
    # =========================================================================
    if dest_wh_id:
        alt_inventories = Inventory.query.filter(
            Inventory.warehouse_id != dest_wh_id,
            Inventory.sku == primary_sku
        ).all()

        for alt_inv in alt_inventories:
            src_wh = alt_inv.warehouse
            src_avail = max(0, alt_inv.quantity - alt_inv.reserved_quantity)
            usable_surplus = max(0, src_avail - alt_inv.reorder_point)

            if usable_surplus > 0:
                transfer_qty = min(deficit_qty, usable_surplus)
                transfer_hours = 36  # Standard inter-hub transit window
                transfer_cost = round(250.0 + (2.50 * transfer_qty), 2)
                
                # Projected inventory balances after simulated transfer
                proj_src_avail = src_avail - transfer_qty
                proj_dest_avail = avail_qty + transfer_qty

                candidate_options.append({
                    'option_id': f'OPT-XFER-{src_wh.code}',
                    'option_type': 'Inter-Warehouse Stock Transfer',
                    'strategy_type': 'Inter-Warehouse Stock Transfer',
                    'title': f'Inter-Warehouse Stock Transfer from {src_wh.code} to {dest_wh_code}',
                    'sku': primary_sku,
                    'quantity': transfer_qty,
                    'source_warehouse_id': src_wh.id,
                    'destination_warehouse_id': dest_wh_id,
                    'source_location': f'{src_wh.code} ({src_wh.location})',
                    'destination_location': f'{dest_wh_code} ({dest_wh.location})',
                    'estimated_cost': transfer_cost,
                    'estimated_delay_reduction_hours': min(disruption.delay_hours, max(12, disruption.delay_hours - 12)),
                    'estimated_duration_hours': transfer_hours,
                    'expected_risk_reduction_pts': 45.0,
                    'feasibility': 'Feasible',
                    'confidence_score': 92.0,
                    'inventory_impact': {
                        'source_current_available': src_avail,
                        'source_projected_available': proj_src_avail,
                        'destination_current_available': avail_qty,
                        'destination_projected_available': proj_dest_avail,
                        'reorder_point_protected': proj_src_avail >= alt_inv.reorder_point
                    },
                    'rationale': (
                        f"Transfer {transfer_qty} units of {primary_sku} from {src_wh.code} surplus stock. "
                        f"Source hub maintains {proj_src_avail} units (above safety threshold {alt_inv.reorder_point}). "
                        f"Delivers in ~{transfer_hours}h for estimated ${transfer_cost:,.2f}."
                    ),
                    'assumptions': 'Inter-facility transport corridor operational; standard loading capacity available.',
                    'proposed_actions': [
                        {'sequence': 1, 'action_type': 'RESERVE_TRANSFER_STOCK', 'description': f'Hold {transfer_qty} units at {src_wh.code} staging bay', 'cost': 50.0, 'role': 'Warehouse Operator'},
                        {'sequence': 2, 'action_type': 'DISPATCH_INTERHUB_FREIGHT', 'description': f'Contract expedited road freight {src_wh.code} -> {dest_wh_code}', 'cost': transfer_cost - 100.0, 'role': 'Supply Chain Manager'},
                        {'sequence': 3, 'action_type': 'RECEIVE_AND_ALLOCATE', 'description': f'Inbound cross-dock intake at {dest_wh_code} and allocate to affected orders', 'cost': 50.0, 'role': 'Warehouse Operator'}
                    ]
                })

    # =========================================================================
    # OPTION 2: Alternative Supplier Expedited Order
    # =========================================================================
    current_supplier_id = disruption.shipment.supplier_id if (disruption.shipment and disruption.shipment.supplier_id) else None
    suppliers = Supplier.query.all()

    for sup in suppliers:
        is_alt = (sup.id != current_supplier_id)
        expedited_lead_days = max(2, (sup.lead_time_days or 10) // 2)
        expedited_lead_hours = expedited_lead_days * 24
        supply_qty = deficit_qty
        unit_price = 45.0  # Baseline component unit cost
        expedite_surcharge = 500.0
        total_supply_cost = round((supply_qty * unit_price) + expedite_surcharge, 2)

        candidate_options.append({
            'option_id': f'OPT-SUP-{sup.code}',
            'option_type': 'Alternative Supplier',
            'strategy_type': 'Alternative Supplier',
            'title': f"{'Alternative' if is_alt else 'Expedited'} Supplier Replenishment via {sup.name}",
            'sku': primary_sku,
            'quantity': supply_qty,
            'source_warehouse_id': None,
            'destination_warehouse_id': dest_wh_id,
            'source_location': f'{sup.name} ({sup.country})',
            'destination_location': f'{dest_wh_code} ({dest_wh.location if dest_wh else "Hub"})',
            'estimated_cost': total_supply_cost,
            'estimated_delay_reduction_hours': max(0, disruption.delay_hours - 24),
            'estimated_duration_hours': expedited_lead_hours,
            'expected_risk_reduction_pts': 35.0,
            'feasibility': 'Feasible' if (sup.reliability_score or 0.8) >= 0.85 else 'Constrained',
            'confidence_score': round((sup.reliability_score or 0.8) * 100, 1),
            'inventory_impact': {
                'source_current_available': 'N/A (External Supplier)',
                'source_projected_available': 'N/A',
                'destination_current_available': avail_qty,
                'destination_projected_available': avail_qty + supply_qty,
                'reorder_point_protected': True
            },
            'rationale': (
                f"Dispatch expedited emergency replenishment order for {supply_qty} units to {sup.name} ({sup.code}). "
                f"Supplier reliability {int((sup.reliability_score or 0.8)*100)}%; estimated turnaround {expedited_lead_days} days. "
                f"Simulated PO authorization only; no real external payment triggered."
            ),
            'assumptions': f'Supplier has open manufacturing capacity for {supply_qty} units; expedited factory slot available.',
            'proposed_actions': [
                {'sequence': 1, 'action_type': 'SUBMIT_EMERGENCY_PO', 'description': f'Authorize simulated replenishment purchase order to {sup.name}', 'cost': total_supply_cost, 'role': 'Procurement Approver'},
                {'sequence': 2, 'action_type': 'MONITOR_INBOUND_PRODUCTION', 'description': 'Track supplier factory production status and export clearance', 'cost': 0.0, 'role': 'Operations Analyst'}
            ]
        })

    # =========================================================================
    # OPTION 3: Shipment Rerouting or Expedited Delivery
    # =========================================================================
    if disruption.shipment:
        shp = disruption.shipment
        delay_saved_hours = min(disruption.delay_hours, max(24, int(disruption.delay_hours * 0.6)))
        expedite_cost = 1450.0  # Standard freight forwarder expedited corridor surcharge

        candidate_options.append({
            'option_id': f'OPT-REROUTE-{shp.tracking_number}',
            'option_type': 'Expedited Freight Rerouting',
            'strategy_type': 'Expedited Freight',
            'title': f'Air Charter Reroute for In-Transit Shipment {shp.tracking_number}',
            'sku': primary_sku,
            'quantity': deficit_qty,
            'source_warehouse_id': None,
            'destination_warehouse_id': dest_wh_id,
            'source_location': f'{shp.origin_city} (Carrier: {shp.carrier})',
            'destination_location': f'{dest_wh_code} ({dest_wh.location if dest_wh else "Hub"})',
            'estimated_cost': expedite_cost,
            'estimated_delay_reduction_hours': delay_saved_hours,
            'estimated_duration_hours': max(12, disruption.delay_hours - delay_saved_hours),
            'expected_risk_reduction_pts': 40.0,
            'feasibility': 'Feasible',
            'confidence_score': 88.0,
            'inventory_impact': {
                'source_current_available': 'In-Transit Freight',
                'source_projected_available': 'In-Transit Freight',
                'destination_current_available': avail_qty,
                'destination_projected_available': avail_qty + deficit_qty,
                'reorder_point_protected': True
            },
            'rationale': (
                f"Bypass transit congestion by rerouting cargo from {shp.carrier} to air express charter. "
                f"Recovers {delay_saved_hours} hours of delay for ${expedite_cost:,.2f}. Simulated freight reservation."
            ),
            'assumptions': 'Airport runway slots and cargo customs fast-track corridor active.',
            'proposed_actions': [
                {'sequence': 1, 'action_type': 'ISSUE_CARRIER_INTERCEPT', 'description': f'Request cargo diversion at nearest transit hub for {shp.tracking_number}', 'cost': 250.0, 'role': 'Supply Chain Manager'},
                {'sequence': 2, 'action_type': 'BOOK_AIR_CHARTER', 'description': 'Reserve simulated express air freight charter', 'cost': 1200.0, 'role': 'Procurement Approver'}
            ]
        })

    # =========================================================================
    # OPTION 4: Customer Order Reprioritisation
    # =========================================================================
    scored_orders = score_and_rank_all_affected_orders(disruption_id=disruption_id)
    if scored_orders:
        top_order = scored_orders[0]
        candidate_options.append({
            'option_id': 'OPT-REPRIORITIZE',
            'option_type': 'Order Reprioritisation',
            'strategy_type': 'Order Reprioritisation',
            'title': f'Priority Allocation: Fulfill Top-Risk Order {top_order["order_number"]} First',
            'sku': primary_sku,
            'quantity': top_order.get('required_quantity', deficit_qty),
            'source_warehouse_id': dest_wh_id,
            'destination_warehouse_id': dest_wh_id,
            'source_location': f'{dest_wh_code} (On-Hand Stock)',
            'destination_location': f'Customer: {top_order["customer_name"]}',
            'estimated_cost': 0.0,  # Zero direct freight spend
            'estimated_delay_reduction_hours': min(24, disruption.delay_hours),
            'estimated_duration_hours': 4,
            'expected_risk_reduction_pts': 25.0,
            'feasibility': 'Feasible',
            'confidence_score': 95.0,
            'inventory_impact': {
                'source_current_available': avail_qty,
                'source_projected_available': max(0, avail_qty - top_order.get('required_quantity', 0)),
                'destination_current_available': avail_qty,
                'destination_projected_available': max(0, avail_qty - top_order.get('required_quantity', 0)),
                'reorder_point_protected': False
            },
            'rationale': (
                f"Sequentially reserve remaining on-hand stock for Critical/Platinum order {top_order['order_number']} "
                f"({top_order['customer_name']}). Avoids total SLA breach on high-consequence customer commitments at $0 financial cost."
            ),
            'assumptions': 'Lower-priority customer orders accept schedule re-baseline without contractual breach penalty.',
            'proposed_actions': [
                {'sequence': 1, 'action_type': 'REORDER_FULFILLMENT_QUEUE', 'description': f'Lock inventory reservation for {top_order["order_number"]}', 'cost': 0.0, 'role': 'Supply Chain Manager'}
            ]
        })

    # =========================================================================
    # OPTION 5: Partial Fulfilment / Split Allocation
    # =========================================================================
    if avail_qty > 0 and avail_qty < total_demand:
        candidate_options.append({
            'option_id': 'OPT-SPLIT-ALLOC',
            'option_type': 'Split Allocation',
            'strategy_type': 'Split Allocation',
            'title': f'Partial Fulfillment: Release {avail_qty} Units Immediately, Backorder Remainder',
            'sku': primary_sku,
            'quantity': avail_qty,
            'source_warehouse_id': dest_wh_id,
            'destination_warehouse_id': dest_wh_id,
            'source_location': f'{dest_wh_code} (Available Inventory)',
            'destination_location': f'{dest_wh_code} (Partial Dispatch)',
            'estimated_cost': 150.0,  # Split packaging and pick fee
            'estimated_delay_reduction_hours': 12,
            'estimated_duration_hours': 8,
            'expected_risk_reduction_pts': 30.0,
            'feasibility': 'Feasible',
            'confidence_score': 90.0,
            'inventory_impact': {
                'source_current_available': avail_qty,
                'source_projected_available': 0,
                'destination_current_available': avail_qty,
                'destination_projected_available': 0,
                'reorder_point_protected': False
            },
            'rationale': (
                f"Ship {avail_qty} immediately available units to prevent customer assembly shutdown. "
                f"Remaining {total_demand - avail_qty} units backordered pending inbound replenishment."
            ),
            'assumptions': 'Customer accepts split shipments and partial deliveries.',
            'proposed_actions': [
                {'sequence': 1, 'action_type': 'DISPATCH_PARTIAL_SHIPMENT', 'description': f'Pick and ship available {avail_qty} units of {primary_sku}', 'cost': 150.0, 'role': 'Warehouse Operator'}
            ]
        })

    # =========================================================================
    # Deterministic Multi-Criteria Recommendation Scoring & Ranking
    # Ranking Score = 0.40 * Risk_Reduction + 0.30 * Delay_Saved - 0.20 * Cost_Factor + 0.10 * Feasibility_Weight
    # =========================================================================
    for opt in candidate_options:
        # Feasibility weight (Feasible = 100, Constrained = 50, Infeasible = 0)
        feas_val = 100.0 if opt['feasibility'] == 'Feasible' else 50.0
        
        # Normalized risk reduction (0 to 100)
        rr_val = min(100.0, opt['expected_risk_reduction_pts'] * 2.0)
        
        # Normalized delay reduction
        delay_val = min(100.0, (opt['estimated_delay_reduction_hours'] / max(1, disruption.delay_hours)) * 100.0)
        
        # Cost factor (penalize high cost: $0 = 100, $5000 = 0)
        cost_score = max(0.0, 100.0 - (opt['estimated_cost'] / 50.0))
        
        rec_score = round(
            (0.35 * rr_val) +
            (0.30 * delay_val) +
            (0.20 * cost_score) +
            (0.15 * feas_val),
            2
        )
        opt['recommendation_score'] = rec_score

    # Deterministic Sorting:
    # 1. Feasible first
    # 2. recommendation_score DESC
    # 3. estimated_cost ASC
    # 4. option_id ASC
    def sort_key(item):
        is_feas = 0 if item['feasibility'] == 'Feasible' else 1
        return (is_feas, -item['recommendation_score'], item['estimated_cost'], item['option_id'])

    sorted_options = sorted(candidate_options, key=sort_key)

    for rank_idx, opt in enumerate(sorted_options, start=1):
        opt['rank'] = rank_idx
        if rank_idx == 1:
            opt['badge'] = 'Primary Recommendation'
        elif rank_idx == 2:
            opt['badge'] = 'Alternative Option'
        else:
            opt['badge'] = 'Fallback Strategy'

    return sorted_options


def create_plan_from_recommendation(
    disruption_id: int,
    option_data: Dict[str, Any],
    user_id: int
) -> RecoveryPlan:
    """
    Creates a new formal RecoveryPlan record and its initial RecoveryAction items
    from a candidate recommendation option.
    Guarantees no duplicate active plans for identical disruption and strategy.
    """
    disruption = db.session.get(Disruption, disruption_id)
    if not disruption:
        raise ValueError(f"Disruption {disruption_id} not found.")

    # Check for existing draft or pending plan with same disruption and strategy type
    existing = RecoveryPlan.query.filter(
        RecoveryPlan.disruption_id == disruption_id,
        RecoveryPlan.strategy_type == option_data.get('strategy_type'),
        RecoveryPlan.status.in_(['Draft', 'Pending Approval'])
    ).first()

    if existing:
        return existing

    # Generate unique plan code
    timestamp_suffix = datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
    plan_code = f"REC-{disruption.disruption_code[-7:]}-{timestamp_suffix[-6:]}"

    plan = RecoveryPlan(
        plan_code=plan_code,
        disruption_id=disruption.id,
        title=option_data.get('title', f"Mitigation for {disruption.disruption_code}"),
        strategy_type=option_data.get('strategy_type', 'Inter-Warehouse Stock Transfer'),
        status='Draft',
        sku=option_data.get('sku'),
        quantity=option_data.get('quantity', 0),
        source_warehouse_id=option_data.get('source_warehouse_id'),
        destination_warehouse_id=option_data.get('destination_warehouse_id'),
        source_location=option_data.get('source_location'),
        destination_location=option_data.get('destination_location'),
        estimated_cost=float(option_data.get('estimated_cost', 0.0)),
        estimated_delay_reduction_hours=int(option_data.get('estimated_delay_reduction_hours', 0)),
        description=option_data.get('rationale', ''),
        rationale=option_data.get('assumptions', ''),
        version=1,
        created_by_id=user_id
    )
    db.session.add(plan)
    db.session.flush()

    # Create associated proposed RecoveryAction items
    proposed_actions = option_data.get('proposed_actions', [])
    for act_data in proposed_actions:
        action = RecoveryAction(
            recovery_plan_id=plan.id,
            action_sequence=act_data.get('sequence', 1),
            action_type=act_data.get('action_type', 'GENERAL_ACTION'),
            description=act_data.get('description', 'Operational mitigation action'),
            status='Pending',
            cost=float(act_data.get('cost', 0.0)),
            assigned_to_role=act_data.get('role', 'Supply Chain Manager')
        )
        db.session.add(action)

    db.session.commit()

    record_audit(
        action='CREATE_RECOVERY_PLAN',
        entity_type='RecoveryPlan',
        entity_id=str(plan.id),
        details=f"Draft plan {plan.plan_code} created for {disruption.disruption_code} ({plan.strategy_type}).",
        user_id=user_id
    )

    create_notification(
        title=f"New Recovery Plan Draft: {plan.plan_code}",
        message=f"Plan '{plan.title}' has been generated and is ready for review.",
        category='Info',
        recipient_role='Supply Chain Manager'
    )

    return plan
