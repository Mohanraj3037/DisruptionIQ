from flask import request, has_request_context
from flask_login import current_user
from app.extensions import db
from app.models.governance import AuditLog


def record_audit(action: str, entity_type: str, entity_id: str = None, details: str = None, user_id: int = None) -> AuditLog:
    """
    Safely creates an AuditLog record in the database.
    Attempts to pull user_id and ip_address from the active request context if available.
    """
    effective_user_id = user_id
    ip_address = None

    if has_request_context():
        if effective_user_id is None and current_user and current_user.is_authenticated:
            effective_user_id = current_user.id
        ip_address = request.headers.get('X-Forwarded-For', request.remote_addr)

    log_entry = AuditLog(
        user_id=effective_user_id,
        action=action,
        entity_type=entity_type,
        entity_id=str(entity_id) if entity_id is not None else None,
        details=details,
        ip_address=ip_address,
    )
    db.session.add(log_entry)
    db.session.commit()
    return log_entry
