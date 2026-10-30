from datetime import datetime, timezone
from flask import Blueprint, render_template, redirect, url_for, flash, request
from flask_login import login_user, logout_user, login_required, current_user
from app.extensions import db
from app.models.user import User
from app.services.audit_service import record_audit

auth_bp = Blueprint('auth', __name__, url_prefix='/auth')


@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard.index'))

    if request.method == 'POST':
        identifier = request.form.get('identifier', '').strip()
        password = request.form.get('password', '')
        remember = bool(request.form.get('remember'))

        if not identifier or not password:
            flash('Please enter both your username/email and password.', 'danger')
            return render_template('auth/login.html')

        # Allow login by username or email
        user = User.query.filter(
            (User.username == identifier) | (User.email == identifier)
        ).first()

        if user and user.check_password(password):
            if not user.is_active:
                flash('This account has been deactivated. Please contact an administrator.', 'danger')
                return render_template('auth/login.html')

            user.last_login = datetime.now(timezone.utc)
            db.session.commit()
            login_user(user, remember=remember)

            record_audit(
                action='LOGIN',
                entity_type='User',
                entity_id=user.id,
                details=f"User '{user.username}' successfully logged in from {request.remote_addr}."
            )

            flash(f'Welcome back, {user.full_name or user.username}!', 'success')
            next_page = request.args.get('next')
            # Ensure the next_page is a safe relative path
            if not next_page or not next_page.startswith('/'):
                next_page = url_for('dashboard.index')
            return redirect(next_page)
        else:
            flash('Invalid credentials. Please verify your username/email and password.', 'danger')
            record_audit(
                action='LOGIN_FAILED',
                entity_type='User',
                details=f"Failed login attempt for identifier '{identifier}' from {request.remote_addr}."
            )

    return render_template('auth/login.html')


@auth_bp.route('/logout', methods=['GET', 'POST'])
@login_required
def logout():
    user_id = current_user.id
    username = current_user.username
    logout_user()
    record_audit(
        action='LOGOUT',
        entity_type='User',
        entity_id=user_id,
        details=f"User '{username}' logged out."
    )
    flash('You have been safely signed out of DisruptionIQ.', 'info')
    return redirect(url_for('auth.login'))


@auth_bp.route('/profile')
@login_required
def profile():
    return render_template('auth/profile.html', user=current_user)
