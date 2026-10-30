"""
DisruptionIQ — Ranked Order Risk Queue Route & API
Provides web and REST interfaces for inspecting, filtering, and analyzing
customer orders ranked by deterministic supply-chain risk scores.
"""

from flask import Blueprint, render_template, request, jsonify
from flask_login import login_required
from app.models.disruptions import Disruption
from app.services.risk_scoring_service import (
    score_and_rank_all_affected_orders,
    RISK_SCORING_CONFIG
)

risk_queue_bp = Blueprint('risk_queue', __name__)


@risk_queue_bp.route('/risk-queue', methods=['GET'])
@login_required
def index():
    """
    Renders the interactive Ranked Order Risk Queue.
    Displays affected orders ranked deterministically from highest to lowest risk.
    """
    severity_filter = request.args.get('severity', 'all').strip()
    status_filter = request.args.get('status', 'all').strip()
    priority_filter = request.args.get('priority', 'all').strip()
    disruption_filter = request.args.get('disruption_id', '').strip()
    search_q = request.args.get('q', '').strip()

    disruption_id = int(disruption_filter) if disruption_filter.isdigit() else None

    # Fetch ranked orders
    ranked_orders = score_and_rank_all_affected_orders(
        disruption_id=disruption_id,
        severity_filter=severity_filter,
        status_filter=status_filter,
        priority_filter=priority_filter,
        search_q=search_q
    )

    # Compute aggregation counts across all active disruptions
    unfiltered_all = score_and_rank_all_affected_orders()
    counts = {
        'total': len(unfiltered_all),
        'critical': sum(1 for o in unfiltered_all if o['severity'] == 'Critical'),
        'high': sum(1 for o in unfiltered_all if o['severity'] == 'High'),
        'medium': sum(1 for o in unfiltered_all if o['severity'] == 'Medium'),
        'low': sum(1 for o in unfiltered_all if o['severity'] == 'Low'),
    }

    # Fetch active disruptions for dropdown
    active_disruptions = Disruption.query.filter(
        Disruption.status.in_(['Active', 'Investigating'])
    ).order_by(Disruption.disruption_code).all()

    return render_template(
        'risk/queue.html',
        orders=ranked_orders,
        active_disruptions=active_disruptions,
        counts=counts,
        current_severity=severity_filter,
        current_status=status_filter,
        current_priority=priority_filter,
        current_disruption_id=disruption_id,
        search_q=search_q,
        scoring_config=RISK_SCORING_CONFIG
    )


@risk_queue_bp.route('/api/risk-queue', methods=['GET'])
@login_required
def api_risk_queue():
    """
    Read-only JSON API returning the ranked order risk queue.
    Supports identical filtering and deterministic sorting rules as the web page.
    """
    severity_filter = request.args.get('severity', 'all').strip()
    status_filter = request.args.get('status', 'all').strip()
    priority_filter = request.args.get('priority', 'all').strip()
    disruption_filter = request.args.get('disruption_id', '').strip()
    search_q = request.args.get('q', '').strip()

    disruption_id = int(disruption_filter) if disruption_filter.isdigit() else None

    ranked = score_and_rank_all_affected_orders(
        disruption_id=disruption_id,
        severity_filter=severity_filter,
        status_filter=status_filter,
        priority_filter=priority_filter,
        search_q=search_q
    )

    # Clean out non-serializable helper datetime keys for JSON
    serializable_orders = []
    for o in ranked:
        clean_o = {k: v for k, v in o.items() if k != 'delivery_deadline_dt'}
        serializable_orders.append(clean_o)

    return jsonify({
        'success': True,
        'total_count': len(serializable_orders),
        'scoring_version': RISK_SCORING_CONFIG['version'],
        'weights': RISK_SCORING_CONFIG['weights'],
        'severity_bands': {k: list(v) for k, v in RISK_SCORING_CONFIG['severity_bands'].items()},
        'orders': serializable_orders
    }), 200
