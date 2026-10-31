import os
from functools import wraps
from flask import abort, flash, redirect, url_for, request
from flask_login import current_user
from app.extensions import db
from app.models.user import User, Role
from app.models.governance import AuditLog


def role_required(*allowed_roles):
    """
    Decorator to restrict route access to specific roles.
    Administrators are always permitted.
    Unauthenticated users are redirected to login.
    Unauthorized users receive HTTP 403.
    """
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not current_user.is_authenticated:
                flash('Please sign in to access this resource.', 'warning')
                return redirect(url_for('auth.login', next=request.url))
            
            if not current_user.has_role(*allowed_roles):
                abort(403)
                
            return f(*args, **kwargs)
        return decorated_function
    return decorator


def get_demo_account_configs():
    """Returns default configuration for local demo accounts."""
    default_password = os.getenv('DEMO_DEFAULT_PASSWORD', 'DisruptionIQ@2026!')
    
    return [
        {
            'username': 'admin',
            'email': 'admin@disruptioniq.local',
            'full_name': 'Chief Logistics Officer (Admin)',
            'role': Role.ADMINISTRATOR,
            'password': os.getenv('DEMO_ADMIN_PASSWORD', default_password),
        },
        {
            'username': 'analyst',
            'email': 'analyst@disruptioniq.local',
            'full_name': 'Sarah Chen (Lead Operations Analyst)',
            'role': Role.OPERATIONS_ANALYST,
            'password': os.getenv('DEMO_ANALYST_PASSWORD', default_password),
        },
        {
            'username': 'manager',
            'email': 'manager@disruptioniq.local',
            'full_name': 'Marcus Vance (Supply Chain Manager)',
            'role': Role.SUPPLY_CHAIN_MANAGER,
            'password': os.getenv('DEMO_MANAGER_PASSWORD', default_password),
        },
        {
            'username': 'warehouse',
            'email': 'warehouse@disruptioniq.local',
            'full_name': 'Dave Miller (Warehouse Operator)',
            'role': Role.WAREHOUSE_OPERATOR,
            'password': os.getenv('DEMO_WAREHOUSE_PASSWORD', default_password),
        },
        {
            'username': 'approver',
            'email': 'approver@disruptioniq.local',
            'full_name': 'Elena Rostova (Procurement Approver)',
            'role': Role.PROCUREMENT_APPROVER,
            'password': os.getenv('DEMO_APPROVER_PASSWORD', default_password),
        },
    ]


def seed_demo_accounts() -> dict:
    """
    Seeds local demo accounts safely if they do not already exist.
    Does NOT wipe or overwrite existing accounts or alter existing passwords.
    Returns a dictionary summarizing accounts created and existing.
    """
    configs = get_demo_account_configs()
    created = []
    existing = []

    for cfg in configs:
        user = User.query.filter_by(username=cfg['username']).first()
        if not user:
            # Check by email as well
            user = User.query.filter_by(email=cfg['email']).first()

        if user:
            existing.append(user.username)
        else:
            new_user = User(
                username=cfg['username'],
                email=cfg['email'],
                full_name=cfg['full_name'],
                role=cfg['role'],
                is_active=True,
            )
            new_user.set_password(cfg['password'])
            db.session.add(new_user)
            db.session.flush()

            # Record audit log
            audit = AuditLog(
                user_id=new_user.id,
                action='CREATE_DEMO_USER',
                entity_type='User',
                entity_id=str(new_user.id),
                details=f"Demo account '{new_user.username}' ({new_user.role}) seeded.",
            )
            db.session.add(audit)
            created.append(new_user.username)

    db.session.commit()
    return {'created': created, 'existing': existing}
