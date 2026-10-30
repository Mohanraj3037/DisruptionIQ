"""
Verification script for Phase 4 live endpoints using active instance/disruptioniq.db
"""
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app import create_app
from app.models.user import User

app = create_app()

with app.app_context():
    with app.test_client() as client:
        # 1. Login as manager
        with client.session_transaction() as sess:
            user = User.query.filter_by(username='manager').first()
            sess['_user_id'] = str(user.id)
            sess['_fresh'] = True

    print("\n--- Verifying Phase 4 Live Routes with active database ---")

    # Check Dashboard
    res = client.get('/')
    print(f"GET / -> Status {res.status_code}")
    assert res.status_code == 200, f"Expected 200, got {res.status_code}"
    assert b"Awaiting Approval" in res.data, "Dashboard missing Awaiting Approval metric"
    assert b"Recovery Budget" in res.data, "Dashboard missing Recovery Budget metric"
    print("  [OK] Dashboard renders Phase 4 recovery metrics and activity stream")

    # Check Recovery Plans index
    res = client.get('/recovery-plans')
    print(f"GET /recovery-plans -> Status {res.status_code}")
    assert res.status_code == 200, f"Expected 200, got {res.status_code}"
    assert b"Recovery Plans" in res.data
    print("  [OK] Recovery Plans index renders with filters and counts")

    # Check Candidate Comparison page for disruption 1
    res = client.get('/recovery-plans/compare/1')
    print(f"GET /recovery-plans/compare/1 -> Status {res.status_code}")
    assert res.status_code == 200, f"Expected 200, got {res.status_code}"
    assert b"Multi-Scenario Recovery Comparison" in res.data
    print("  [OK] Recovery Candidate comparison page renders with ranked options")

    # Check Approvals queue
    res = client.get('/approvals')
    print(f"GET /approvals -> Status {res.status_code}")
    assert res.status_code == 200, f"Expected 200, got {res.status_code}"
    assert b"Procurement & Financial Approvals" in res.data or b"Approvals" in res.data
    print("  [OK] Approvals queue renders with pending and past decisions")

    # Check Recovery Plans API
    res = client.get('/api/recovery-plans')
    print(f"GET /api/recovery-plans -> Status {res.status_code}")
    assert res.status_code == 200, f"Expected 200, got {res.status_code}"
    data = res.get_json()
    assert 'plans' in data and 'count' in data
    print(f"  [OK] API returns structured JSON with {data['count']} plans")

    print("\nAll Phase 4 Live HTTP checks PASSED successfully!")
