"""
DisruptionIQ — Notification Service
Manages creation and retrieval of in-app notifications for role-based users.
"""

from typing import Optional, List
from app.extensions import db
from app.models.governance import Notification
from app.models.user import User, Role


def create_notification(
    title: str,
    message: str,
    category: str = 'Info',
    recipient_role: Optional[str] = None,
    recipient_user_id: Optional[int] = None
) -> Notification:
    """
    Creates an in-app Notification record in the database.
    Can target an individual user (recipient_user_id) or an entire operational role (recipient_role).
    """
    notif = Notification(
        title=title,
        message=message,
        category=category,
        recipient_role=recipient_role,
        recipient_user_id=recipient_user_id,
        is_read=False
    )
    db.session.add(notif)
    db.session.commit()
    return notif


def get_user_notifications(user: User, limit: int = 10, unread_only: bool = False) -> List[Notification]:
    """Retrieves notifications targeted to the user's role or user ID."""
    if not user or not user.is_authenticated:
        return []

    query = Notification.query.filter(
        db.or_(
            Notification.recipient_user_id == user.id,
            Notification.recipient_role == user.role,
            Notification.recipient_role == 'All'
        )
    )

    if unread_only:
        query = query.filter_by(is_read=False)

    return query.order_by(Notification.created_at.desc()).limit(limit).all()


def get_unread_count(user: User) -> int:
    """Returns total count of unread notifications for a user."""
    if not user or not user.is_authenticated:
        return 0

    return Notification.query.filter(
        db.or_(
            Notification.recipient_user_id == user.id,
            Notification.recipient_role == user.role,
            Notification.recipient_role == 'All'
        ),
        Notification.is_read == False
    ).count()
