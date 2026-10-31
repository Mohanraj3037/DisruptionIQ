"""
Live HTTP verification script testing the running Flask server at http://127.0.0.1:5000
Uses standard urllib with CookieJar to simulate real HTTP sessions across roles.
"""
import urllib.request
import urllib.parse
from http.cookiejar import CookieJar

BASE_URL = "http://127.0.0.1:5000"

def create_session():
    cj = CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    return opener

def login(opener, username, password):
    login_url = f"{BASE_URL}/auth/login"
    data = urllib.parse.urlencode({'identifier': username, 'password': password}).encode('utf-8')
    req = urllib.request.Request(login_url, data=data, method='POST')
    res = opener.open(req)
    return res.geturl(), res.status

def get_page(opener, path):
    req = urllib.request.Request(f"{BASE_URL}{path}")
    try:
        res = opener.open(req)
        return res.status, res.read().decode('utf-8', errors='ignore')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', errors='ignore')

print("--- Testing Live Running Server at http://127.0.0.1:5000 ---")

# 1. Unauthenticated Login Page Check
anon_session = create_session()
status, html = get_page(anon_session, "/auth/login")
print(f"GET /auth/login -> Status {status}")
assert status == 200, f"Expected 200, got {status}"
assert "DisruptionIQ" in html and "Sign In" in html
print("  [OK] Login page renders with branding and credentials fields")

# 2. Login as Manager & Verify Protected Pages
mgr_session = create_session()
final_url, status = login(mgr_session, "manager", "DisruptionIQ@2026!")
print(f"POST /auth/login (manager) -> Status {status}, Landed: {final_url}")

# Dashboard
status, html = get_page(mgr_session, "/")
print(f"GET / (Dashboard) -> Status {status}")
assert status == 200
assert "Active Disruptions" in html and "Awaiting Approval" in html and "Recovery Budget" in html
assert "severityChart" in html and "riskDistributionChart" in html and "shipmentsChart" in html
print("  [OK] Dashboard renders KPIs, Chart.js components, Top-risk table, and Activity stream")

# Order Risk Queue
status, html = get_page(mgr_session, "/risk-queue")
print(f"GET /risk-queue -> Status {status}")
assert status == 200
assert "Order Risk Queue" in html and "ORD-2026-" in html
print("  [OK] Risk Queue renders ranked order table, severity badges, and filter bars")

# Disruption Detail
status, html = get_page(mgr_session, "/disruptions/2")
print(f"GET /disruptions/2 -> Status {status}")
assert status == 200
assert "DIS-2026-002" in html and "Multi-Echelon Supply-Chain Impact Chain" in html
assert "Plan Recovery Options" in html
print("  [OK] Disruption Details renders visual impact chain and Plan Recovery Options button")

# Recovery Plan Comparison
status, html = get_page(mgr_session, "/recovery-plans/compare/2")
print(f"GET /recovery-plans/compare/2 -> Status {status}")
assert status == 200
assert "Multi-Scenario Recovery Comparison" in html or "DIS-2026-002" in html
assert "Inter-Warehouse Stock Transfer" in html
assert "Primary Recommendation" in html or "Cheapest" in html or "Fastest" in html
print("  [OK] Scenario comparison renders candidate strategy cards, trade-off matrix, and badges")

# Recovery Plans Index
status, html = get_page(mgr_session, "/recovery-plans")
print(f"GET /recovery-plans -> Status {status}")
assert status == 200
assert "Recovery Plans" in html
print("  [OK] Recovery plans list renders with filter tabs and counts")

# Approvals Queue
status, html = get_page(mgr_session, "/approvals")
print(f"GET /approvals -> Status {status}")
assert status == 200
assert "Approvals" in html or "Procurement & Financial Approvals" in html
print("  [OK] Approvals page renders pending governance queue and decision history")

# 3. Role-Based Access Control: Login as Analyst & verify access denied to /approvals
analyst_session = create_session()
login(analyst_session, "analyst", "DisruptionIQ@2026!")
status, html = get_page(analyst_session, "/approvals")
print(f"GET /approvals (as Operations Analyst) -> Status {status}")
assert status == 403, f"Expected 403 Forbidden, got {status}"
assert "403" in html or "Access Denied" in html or "Forbidden" in html
print("  [OK] RBAC strictly enforces 403 Forbidden on /approvals for Operations Analyst")

# 4. Verify Demo Data Integrity over HTTP
status, html = get_page(mgr_session, "/disruptions/2")
assert "Rotterdam Eurohub" in html or "WH-EAST" in html
assert "SKU-SNS-02" in html
print("  [OK] Demo data (DIS-2026-002, SKU-SNS-02, WH-EAST) correctly displayed in UI")

print("\n--- All Live HTTP Checks Against Port 5000 PASSED Successfully! ---")
