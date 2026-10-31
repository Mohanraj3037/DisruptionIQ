from flask import Blueprint, render_template
from flask_login import login_required
from app.models.user import Role
from app.services.auth_service import role_required
from app.models.disruptions import Disruption, RecoveryPlan
from app.models.orders import CustomerOrder
from app.models.governance import Approval, AuditLog

placeholders_bp = Blueprint('placeholders', __name__)


from flask import redirect, url_for

@placeholders_bp.route('/placeholders/disruptions')
@login_required
def disruptions():
    return redirect(url_for('logistics.disruptions'))


@placeholders_bp.route('/placeholders/orders')
@login_required
def orders():
    return redirect(url_for('logistics.orders'))


@placeholders_bp.route('/placeholders/recovery-plans')
@login_required
def recovery_plans():
    return redirect(url_for('recovery.index'))


@placeholders_bp.route('/placeholders/approvals')
@login_required
def approvals():
    return redirect(url_for('recovery.approvals'))




@placeholders_bp.route('/audit-logs')
@login_required
@role_required(Role.ADMINISTRATOR)
def audit_logs():
    count = AuditLog.query.count()
    recent_logs = AuditLog.query.order_by(AuditLog.timestamp.desc()).limit(15).all()
    return render_template(
        'placeholders/audit_logs.html',
        page_title='System Audit Logs',
        page_icon='bi-journal-text',
        subtitle='Immutable record of user logins, role modifications, approvals and automated disruption events.',
        item_count=count,
        recent_logs=recent_logs
    )
