import os
from flask import Flask, render_template
from app.config import config_by_name
from app.extensions import db, login_manager


def create_app(config_name=None):
    """
    Application factory pattern.
    Configures and initializes Flask, extensions, blueprints, and error handlers.
    """
    if config_name is None:
        config_name = os.getenv('FLASK_ENV', 'development')

    app = Flask(__name__)
    app.config.from_object(config_by_name.get(config_name, config_by_name['default']))

    # Initialize extensions
    db.init_app(app)
    login_manager.init_app(app)

    # Register blueprints
    from app.routes.auth import auth_bp
    from app.routes.dashboard import dashboard_bp
    from app.routes.placeholders import placeholders_bp
    from app.routes.logistics import logistics_bp
    from app.routes.data_import import import_bp
    from app.routes.webhooks import webhooks_bp
    from app.routes.risk_queue import risk_queue_bp
    from app.routes.recovery import recovery_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(placeholders_bp)
    app.register_blueprint(logistics_bp)
    app.register_blueprint(import_bp)
    app.register_blueprint(webhooks_bp)
    app.register_blueprint(risk_queue_bp)
    app.register_blueprint(recovery_bp)

    # Error Handlers
    @app.errorhandler(403)
    def forbidden_error(error):
        return render_template('errors/403.html'), 403

    @app.errorhandler(404)
    def not_found_error(error):
        return render_template('errors/404.html'), 404

    @app.errorhandler(500)
    def internal_error(error):
        db.session.rollback()
        return render_template('errors/500.html'), 500

    # Context processors for templates
    @app.context_processor
    def inject_global_template_data():
        from app.models.user import Role
        return {
            'app_name': 'DisruptionIQ',
            'app_tagline': 'Logistics Disruption Control Tower',
            'available_roles': Role.ALL_ROLES,
        }

    # Register custom CLI commands
    @app.cli.command('init-db')
    def init_db_command():
        """Creates database tables and seeds default demo accounts."""
        from app.services.auth_service import seed_demo_accounts
        db.create_all()
        result = seed_demo_accounts()
        print(f"[OK] Database initialized successfully.")
        print(f"     Created accounts: {result['created']}")
        print(f"     Existing accounts: {result['existing']}")

    @app.cli.command('seed-data')
    def seed_data_command():
        """Seeds synthetic logistics data (suppliers, warehouses, SKUs, shipments, orders, disruptions)."""
        from app.services.seed_service import seed_logistics_data
        result = seed_logistics_data()
        print(f"[OK] Logistics seed completed.")
        for k, v in result.items():
            print(f"     {k}: {v}")

    return app
