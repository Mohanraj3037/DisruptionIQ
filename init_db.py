import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import create_app
from app.extensions import db
from app.services.auth_service import seed_demo_accounts, get_demo_account_configs
from app.services.seed_service import seed_logistics_data


def safe_migrate_columns():
    """
    Ensures newly added model columns exist in the SQLite database without
    dropping or wiping any existing records.
    """
    inspector = db.inspect(db.engine)
    existing_tables = inspector.get_table_names()

    # 1. Update suppliers table if needed
    if 'suppliers' in existing_tables:
        cols = [c['name'] for c in inspector.get_columns('suppliers')]
        if 'lead_time_days' not in cols:
            db.session.execute(db.text("ALTER TABLE suppliers ADD COLUMN lead_time_days INTEGER NOT NULL DEFAULT 7;"))
        if 'expected_supply_date' not in cols:
            db.session.execute(db.text("ALTER TABLE suppliers ADD COLUMN expected_supply_date DATETIME;"))

    # 2. Update customer_orders table if needed
    if 'customer_orders' in existing_tables:
        cols = [c['name'] for c in inspector.get_columns('customer_orders')]
        if 'assigned_warehouse_id' not in cols:
            db.session.execute(db.text("ALTER TABLE customer_orders ADD COLUMN assigned_warehouse_id INTEGER REFERENCES warehouses(id);"))

    # 3. Update disruptions table if needed
    if 'disruptions' in existing_tables:
        cols = [c['name'] for c in inspector.get_columns('disruptions')]
        if 'shortage_category' not in cols:
            db.session.execute(db.text("ALTER TABLE disruptions ADD COLUMN shortage_category VARCHAR(64) NOT NULL DEFAULT 'None';"))
        if 'warehouse_id' not in cols:
            db.session.execute(db.text("ALTER TABLE disruptions ADD COLUMN warehouse_id INTEGER REFERENCES warehouses(id);"))

    db.session.commit()


def init_database():
    """Initializes SQLite database tables and seeds demo accounts and logistics data without wiping existing data."""
    app = create_app('development')
    
    with app.app_context():
        # Ensure instance directory exists
        instance_path = Path(app.instance_path)
        instance_path.mkdir(parents=True, exist_ok=True)
        db_file = instance_path / 'disruptioniq.db'
        
        print("=" * 70)
        print(" DisruptionIQ — Database Initialization & Logistics Demo Setup")
        print("=" * 70)
        print(f"Target Database File: {db_file}")
        
        # 1. Create all missing tables safely
        db.create_all()
        # 2. Apply non-destructive column migrations
        safe_migrate_columns()
        print("[OK] All database tables and columns verified.")
        
        # 3. Seed demo role accounts
        auth_result = seed_demo_accounts()
        
        print("\n1. Demo Accounts Status:")
        print("-" * 70)
        print(f"{'Role':<24} {'Username':<12} {'Email':<25}")
        print("-" * 70)
        
        configs = get_demo_account_configs()
        for cfg in configs:
            status = "(Created)" if cfg['username'] in auth_result['created'] else "(Existing)"
            print(f"{cfg['role']:<24} {cfg['username']:<12} {cfg['email']:<25} {status}")
        
        print("-" * 70)
        default_pwd = configs[0]['password']
        print(f"Default Local Demo Password: {default_pwd}")

        # 4. Seed realistic synthetic logistics dataset (Scenarios A & B)
        print("\n2. Logistics Dataset Seeding:")
        print("-" * 70)
        logistics_result = seed_logistics_data()
        for entity, count in logistics_result.items():
            print(f"  • {entity.capitalize():<16}: {count} new records added (existing records preserved)")

        print("=" * 70)
        print("[OK] Database initialization and logistics dataset seeding completed.\n")


if __name__ == '__main__':
    init_database()
