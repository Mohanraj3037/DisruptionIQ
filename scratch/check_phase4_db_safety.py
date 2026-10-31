"""
Verification script for Check 6: Database Safety and Integrity
Inspects instance/disruptioniq.db and instance/disruptioniq_backup_phase3.db
"""
import sys
import os
import sqlite3

db_path = r"D:\IQ\instance\disruptioniq.db"
backup_path = r"D:\IQ\instance\disruptioniq_backup_phase3.db"

print("--- Database Safety Check ---")
print(f"Active DB exists: {os.path.exists(db_path)} (Size: {os.path.getsize(db_path)} bytes)")
print(f"Backup DB exists: {os.path.exists(backup_path)} (Size: {os.path.getsize(backup_path)} bytes)")

con = sqlite3.connect(db_path)
cur = con.cursor()

# Check tables
tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
print(f"\nTables present ({len(tables)}): {sorted(tables)}")

# Check core Phase 1-3 record counts
entity_counts = {}
for tbl in ['users', 'suppliers', 'warehouses', 'inventories', 'shipments', 'shipment_items', 
            'customer_orders', 'order_items', 'disruptions', 'disruption_affected_orders',
            'audit_logs', 'notifications', 'recovery_plans', 'recovery_actions', 'approvals']:
    if tbl in tables:
        count = cur.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
        entity_counts[tbl] = count
    else:
        entity_counts[tbl] = "TABLE_NOT_FOUND"

print("\nActive Record Counts in disruptioniq.db:")
for tbl, cnt in entity_counts.items():
    print(f"  {tbl:28s}: {cnt}")

# Check columns of recovery_plans to ensure non-destructive migration
cur.execute("PRAGMA table_info(recovery_plans)")
plan_cols = [r[1] for r in cur.fetchall()]
print(f"\nrecovery_plans columns ({len(plan_cols)}): {plan_cols}")

# Check columns of recovery_actions
cur.execute("PRAGMA table_info(recovery_actions)")
action_cols = [r[1] for r in cur.fetchall()]
print(f"\nrecovery_actions columns ({len(action_cols)}): {action_cols}")

# Verify specific Phase 1-3 seed records
shp3 = cur.execute("SELECT tracking_number, status, origin_city, destination_warehouse_id FROM shipments WHERE tracking_number='SHP-2026-003'").fetchone()
print(f"\nScenario A Shipment (SHP-2026-003): {shp3}")

dis2 = cur.execute("SELECT disruption_code, title, severity, status FROM disruptions WHERE disruption_code='DIS-2026-002'").fetchone()
print(f"Scenario B Disruption (DIS-2026-002): {dis2}")

ord12 = cur.execute("SELECT order_number, customer_name, status, total_value FROM customer_orders WHERE order_number='ORD-2026-012'").fetchone()
print(f"Scenario B Affected Order (ORD-2026-012): {ord12}")

con.close()
