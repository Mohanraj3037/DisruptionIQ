# DisruptionIQ

Logistics Disruption Management Web Application — Hackathon Project.

## 1. Approved Technology Stack

| Layer | Technology | Usage / Delivery |
|---|---|---|
| **Frontend** | HTML5, CSS3, JavaScript, Bootstrap 5 | Responsive UI layout, control tower dashboard, components via jsDelivr CDN |
| **Backend** | Python Flask (Application Factory) | Modular server architecture, blueprints, deterministic calculation services |
| **Database** | SQLite with Flask-SQLAlchemy | Local file-based database stored under `instance/disruptioniq.db` |
| **Authentication** | Flask-Login | Session-based authentication with role-based access control |
| **Data Visualisation** | Chart.js | Interactive analytics charts via jsDelivr CDN |
| **AI Integration** | Optional LLM API | Fallback to deterministic rule/template engine when unavailable |

> **Constraint Notice:** Frameworks such as React, Next.js, Node.js, and MongoDB are strictly excluded per project architecture guidelines. Authoritative risk scores and inventory allocations are 100% deterministic and calculated strictly by backend business logic without LLM hallucination.

---

## 2. Project Architecture & Directory Structure

```
d:\IQ\
├── app/
│   ├── __init__.py               # Flask application factory (create_app)
│   ├── config.py                 # Environment-driven configurations
│   ├── extensions.py             # SQLAlchemy and LoginManager instances
│   ├── models/                   # Relational models and domain constraints
│   │   ├── __init__.py           # Exposes all models
│   │   ├── user.py               # User, Role constants
│   │   ├── logistics.py          # Supplier, Warehouse, Inventory, Shipment, ShipmentItem
│   │   ├── orders.py             # CustomerOrder, OrderItem
│   │   ├── disruptions.py        # Disruption, DisruptionAffectedOrder, RecoveryPlan, RecoveryAction
│   │   └── governance.py         # Approval, AuditLog, WebhookEvent, Notification
│   ├── routes/                   # Modular blueprints
│   │   ├── auth.py               # Login, logout, profile
│   │   ├── dashboard.py          # Live KPI queries, dashboard views, Chart.js telemetry API
│   │   ├── logistics.py          # Suppliers, warehouses, shipments, inventory, disruptions
│   │   ├── orders.py             # Customer orders & order line items
│   │   ├── risk_queue.py         # Order Risk Queue (/risk-queue) & JSON API (/api/risk-queue)
│   │   ├── webhooks.py           # Carrier webhook endpoint & simulator
│   │   ├── imports.py            # CSV / JSON ingestion with schema validation
│   │   └── placeholders.py       # Recovery Plans, Approvals, Audit Logs
│   ├── services/                 # Reusable business logic
│   │   ├── auth_service.py       # Role enforcement decorator & demo account seeder
│   │   ├── audit_service.py      # Immutable governance audit logger
│   │   ├── impact_analysis_service.py # Multi-echelon supply-chain impact chain analyzer
│   │   ├── risk_scoring_service.py    # Deterministic 4-component risk scoring engine
│   │   ├── webhook_service.py    # Idempotent carrier webhook handler with disruption detection
│   │   └── import_service.py     # Transactional batch importer
│   ├── static/
│   │   ├── css/custom.css        # Enterprise control tower theme (#0B1220, #172235, #F5B84B, #34D399, #F87171)
│   │   └── js/dashboard.js       # Dynamic Chart.js visualizations (Severity, Status, Risk Distribution)
│   └── templates/                # Jinja2 templates
│       ├── base.html             # Shell with sidebar, navigation, header, and CDN imports
│       ├── auth/                 # Login and profile templates
│       ├── dashboard/            # Control tower dashboard with KPI cards, 3 charts & top-risk table
│       ├── risk/
│       │   └── queue.html        # Interactive Order Risk Queue with filtering & evidence modal
│       ├── logistics/            # Disruption detail (with visual impact chain), shipments, inventory
│       ├── orders/               # Customer order listings and details
│       ├── webhooks/             # Carrier simulator UI
│       └── errors/               # 403, 404, 500 error templates
├── instance/                     # SQLite database storage (disruptioniq.db)
├── uploads/                      # Local file uploads (git-ignored)
├── tests/                        # Automated test suite (69 tests with unittest)
│   ├── test_base.py              # Base test fixture with in-memory SQLite
│   ├── test_models.py            # Constraints, relationships & hashing tests
│   ├── test_auth.py              # Login, logout, role restrictions & 403 tests
│   ├── test_routes.py            # Dashboard, API, placeholder, and 404 tests
│   ├── test_seed_data.py         # Synthetic seed verification and Scenario A/B checks
│   ├── test_webhooks.py          # Webhook idempotency and delay simulation tests
│   ├── test_imports.py           # CSV/JSON ingestion tests
│   ├── test_risk_engine.py       # 12 deterministic formula, bounds, shortages, and allocation tests
│   └── test_risk_routes.py       # 6 Risk queue, API, filter, and dashboard integration tests
├── init_db.py                    # Repeatable DB initialization & demo account seeding script
├── run.py                        # Application entrypoint
├── requirements.txt              # Pinned Python package dependencies
├── .env.example                  # Configuration template
├── .gitignore                    # Secrets, databases, and venv ignore rules
└── README.md                     # Documentation and startup instructions
```

---

## 3. Phase 3: Intelligent Impact Analysis & Deterministic Risk Scoring

### 3.1 Impact Analysis Service (`app/services/impact_analysis_service.py`)

For each active disruption, the impact analysis service traces the complete physical supply-chain chain:
$$\text{Supplier} \longrightarrow \text{Shipment} \longrightarrow \text{Destination Warehouse} \longrightarrow \text{SKU / Inventory} \longrightarrow \text{Customer Orders}$$

Calculated impact metrics include:
1. **Disruption Metadata:** Disruption code, title, disruption type, status, and severity.
2. **Linked Supplier & Shipment:** Supplier name, carrier, tracking number, and origin.
3. **Affected SKU & Destination Warehouse:** SKU identifier, product name, and destination facility.
4. **Current Available Inventory:** Net usable stock calculated strictly as `quantity - reserved_quantity`.
5. **Reserved Inventory:** Pre-allocated stock committed to existing orders.
6. **Incoming Inventory & Arrival:** Units on inbound shipments with expected arrival timestamps.
7. **Total Demand from Affected Customer Orders:** Aggregate unit demand across unfulfilled commitments.
8. **Confirmed Shortage:** When current available inventory cannot cover immediate order requirements ($Demand > Available$).
9. **Potential Shortage:** When delayed inbound transit risks starving downstream demand before delivery SLAs.
10. **Estimated Shipment Delay:** Transit variance in hours and days.
11. **Affected Orders:** Individual orders with order numbers, customer tiers, requested quantities, and delivery deadlines.
12. **Alternative Warehouse Buffers:** Identifies sister facilities in the network with transferable surplus (`quantity - reserved_quantity > reorder_point`).
13. **Deterministic Explanations:** Objective textual synthesis explaining exact breach mechanisms.

---

### 3.2 Deterministic Risk Scoring Engine (`app/services/risk_scoring_service.py`)

Every affected customer order receives a deterministic risk score calculated from four normalized components ($0 \text{ to } 100$):

$$\text{Final Risk Score} = 0.35 \times \text{Deadline Risk} + 0.30 \times \text{Shortage Risk} + 0.20 \times \text{Customer Priority} + 0.15 \times \text{Recovery Difficulty}$$

The score is rounded to two decimal places.

#### Scoring Component Rules:

1. **Deadline Risk ($35\%$ Weight):**
   - Evaluates the temporal buffer between the order's promised delivery deadline and the disruption's estimated arrival delay.
   - **Overdue Orders:** $100.0$ (deadline has already passed).
   - **Critical SLA Breach:** $95.0$ (estimated delay directly exceeds the available time before deadline).
   - **High Imminent Threat:** $80.0$ (remaining buffer is under 24 hours).
   - **Moderate Buffer:** $50.0$ (remaining buffer between 24 and 72 hours).
   - **Safe Buffer:** $20.0$ (over 72 hours remaining with minimal delay).
   - **Missing/Unknown Deadline Fallback:** Evaluated at $50.0$ as an explicit uncertainty risk factor.

2. **Shortage Risk ($30\%$ Weight):**
   - Evaluates available stock after deducting reservations (`quantity - reserved_quantity`).
   - Distinguishes **Confirmed Shortages** ($100.0$ if warehouse has 0 available units, $85.0$ if partial stock exists) from **Potential Shortages** ($65.0$ for delayed inbound transit with demand competition).
   - Delayed inbound stock is never treated as currently available inventory.
   - If stock is completely sufficient ($Available \ge Demand$), score drops to $10.0$.

3. **Customer Priority ($20\%$ Weight):**
   - Mapped from order priority:
     - `Critical`: $90.0$
     - `High`: $70.0$
     - `Medium`: $40.0$
     - `Low`: $15.0$
   - Combined with Customer Tier adjustments:
     - `Platinum`: $+10.0$ bonus
     - `Gold`: $+5.0$ bonus
     - `Standard`: $+0.0$
   - Capped strictly at $[0, 100]$.

4. **Recovery Difficulty ($15\%$ Weight):**
   - Evaluates network transfer feasibility and alternative inventory surplus.
   - **No Alternative Stock in Network:** $90.0$ difficulty.
   - **Alternative Stock Exists but Lead Time $>7$ days:** $70.0$ difficulty.
   - **Alternative Stock Exists with Moderate Lead Time (3–7 days):** $45.0$ difficulty.
   - **Surplus Stock Available Nearby ($<3$ days):** $20.0$ difficulty.

#### Severity Bands:
- **Critical:** $80.00 - 100.00$
- **High:** $60.00 - 79.99$
- **Medium:** $30.00 - 59.99$
- **Low:** $0.00 - 29.99$

#### Deterministic Tie-Breaking & Sorting:
When ranking the Order Risk Queue, ties are broken deterministically:
1. `final_risk_score` (Descending)
2. `delivery_deadline` (Ascending — earliest deadline first; missing deadlines placed last)
3. `order_number` (Ascending alphabetical)

---

### 3.3 Dynamic Recalculation Strategy

To prevent stale risk rankings, risk scores are computed dynamically from current database records upon request. Any change in:
- Inbound shipment tracking or carrier delay events,
- Warehouse inventory or reservation counts,
- Customer order quantities or line items,
- Disruption status or severity updates,

is immediately and automatically reflected on the next request to `/risk-queue`, `/api/risk-queue`, `/disruptions/<id>`, or `/`.

---

## 4. Web Views & Read-Only APIs

### 4.1 Order Risk Queue (`/risk-queue`)
Interactive queue ranking affected customer orders with:
- **Search & Filter Controls:** Filter by Severity (Critical, High, Medium, Low), Order Status, Customer Priority, Source Disruption, or Free-text Search (Order Number, Customer Name, SKU).
- **Evidence Modal:** Clicking the **Evidence** button on any row displays an interactive modal breaking down the four normalized components, individual weights, numeric sub-scores, and human-readable justification.

### 4.2 Read-Only JSON API (`GET /api/risk-queue`)
Programmatic endpoint returning ranked orders with complete evidence telemetry:
- **URL:** `/api/risk-queue`
- **Method:** `GET`
- **Query Parameters:** `severity`, `status`, `priority`, `disruption`, `q`
- **Authentication:** Requires active session with authorized role.
- **Payload Structure:**
  ```json
  {
    "status": "success",
    "scoring_version": "v3.0-deterministic",
    "weights": {
      "deadline_risk": 0.35,
      "shortage_risk": 0.30,
      "customer_priority": 0.20,
      "recovery_difficulty": 0.15
    },
    "severity_bands": {
      "Critical": [80.0, 100.0],
      "High": [60.0, 79.99],
      "Medium": [30.0, 59.99],
      "Low": [0.0, 29.99]
    },
    "total_affected_orders": 4,
    "orders": [
      {
        "rank": 1,
        "order_id": 4,
        "order_number": "ORD-2026-004",
        "customer_name": "Tesla Gigafactory Europe",
        "customer_tier": "Platinum",
        "order_priority": "Critical",
        "final_risk_score": 84.32,
        "severity": "Critical",
        "components": {
          "deadline_risk": 95.0,
          "shortage_risk": 85.0,
          "customer_priority": 100.0,
          "recovery_difficulty": 45.0
        },
        "weighted_breakdown": {
          "deadline_contribution": 33.25,
          "shortage_contribution": 25.5,
          "priority_contribution": 20.0,
          "recovery_contribution": 6.75
        }
      }
    ]
  }
  ```

### 4.3 Enhanced Disruption Detail (`/disruptions/<id>`)
- **Multi-Echelon Impact Chain Flow:** Clean, responsive visual flow showing:
  `Supplier [Origin] ──> Shipment [Tracking] ──> Hub [Warehouse] ──> SKU [Balance] ──> Customer Orders`
- **Expandable Evidence Accordion:** Detailed evidence breakdown per affected order.
- **Direct Recovery Action:** Action button linking directly to `/recovery-plans/compare/<id>` for immediate scenario analysis.

### 4.4 Control Tower Dashboard (`/`)
- Real-time KPIs for Active Disruptions, Confirmed vs Potential Shortages, Critical/High Risk Orders, Inbound Delays, and Phase 4 Recovery Metrics (Awaiting Approval, Ready to Execute, Executed Plans, and Active Recovery Budget).
- Three synchronized Chart.js analytics graphs:
  1. **Disruptions by Severity** (Doughnut Chart)
  2. **Order Risk Distribution** (Doughnut Chart)
  3. **Shipments by Status** (Bar Chart)
- Ranked **Highest-Risk Customer Orders** operational summary table.
- Live **Recent Recovery Plans & Governance Activity** audit stream.

---

## 5. Phase 4: Intelligent Recovery Planning, Approval Workflow & Simulated Execution

### 5.1 Recommendation Engine (`app/services/recovery_planning_service.py`)
For each active disruption, the recommendation engine deterministically queries relational state and generates up to five candidate recovery strategies:
1. **Option 1: Inter-Warehouse Stock Transfer**
   - Identifies candidate donor warehouses holding usable surplus (`quantity - reserved_quantity - reorder_point > 0`).
   - Caps transfer quantity strictly to available surplus.
   - Computes realistic transfer duration and cost ($150 base + $4.25/unit).
   - Generates projected source and destination inventory balances post-transfer.
2. **Option 2: Alternative Supplier Replenishment**
   - Discovers alternative qualified vendors from supplier directory.
   - Calculates purchase cost based on configured unit prices ($145.00/unit) and vendor lead times (72h).
   - Flags assumptions explicitly; never places real purchase orders.
3. **Option 3: Shipment Rerouting / Expedited Freight**
   - Evaluates active inbound shipments and computes expedited transit options.
   - Models air-freight speedup (-24h delay reduction) with premium logistics surcharge ($850 base).
4. **Option 4: Customer Order Reprioritisation**
   - Formulates priority dispatch schedules based on deterministic order-risk rankings and customer tiers.
   - Minimizes commercial penalty risk ($75 admin cost, 12h resolution).
5. **Option 5: Split Allocation / Partial Fulfilment**
   - Allocates available on-hand stock immediately while staging backorders for incoming shipments.
   - Prevents double-allocation of reserved inventory.

#### Deterministic Multi-Criteria Recommendation Ranking Formula
Every candidate strategy is evaluated on a normalized 0–100 multi-criteria utility score:
$$\text{Ranking Score} = 0.35 \times \text{RiskReduction} + 0.30 \times \text{DelayReduction} + 0.20 \times (100 - \text{NormalizedCost}) + 0.15 \times \text{FeasibilityScore}$$
- **Cheapest** and **Fastest** badges are dynamically assigned based on verifiable quantitative minima.
- If no feasible options exist, the engine returns actionable diagnostics identifying missing data or supply constraints.

### 5.2 Plan Comparison & Creation (`/recovery-plans/compare/<id>`)
- Side-by-side strategy comparison cards displaying estimated cost, delay reduction, feasibility confidence, and trade-off matrices.
- One-click plan creation converts recommendations into formal `RecoveryPlan` and `RecoveryAction` database records with duplicate-plan prevention.

### 5.3 Role-Based Approval Workflow (`/approvals`)
Enforces a finite state machine with strict separation of duties:
$$\text{Draft} \longrightarrow \text{Pending Approval} \longrightarrow \text{Approved} \longrightarrow \text{Execution Ready} \longrightarrow \text{Executed (Simulated)}$$
- **Alternative States:** `Rejected`, `Changes Requested`, `Cancelled`, `Execution Failed`.
- **Separation of Duties:** The user who created a plan cannot approve their own plan (`created_by_id != approver_id`), preventing governance conflicts.
- **Mandatory Justification:** All rejection or revision decisions require non-empty rationale comments.
- **Approval Version Snapshot:** When approved, the plan locks an `approval_version = version`. If the plan is edited post-approval, its status automatically reverts to `Draft`, invalidating the approval and requiring re-submission.

### 5.4 Pre-Flight Confirmation & Safe Simulated Execution (`/recovery-plans/<id>/confirm-execution`)
Simulated execution is completely isolated from external carriers, suppliers, or payment gateways. Execution requires all six safeguards:
1. Plan must be in an `Approved` state.
2. Plan version must match `approval_version` (unmodified post-approval).
3. Acting user must possess execution clearance (`Warehouse Operator`, `Supply Chain Manager`, or `Administrator`).
4. User must provide explicit confirmation via mandatory acknowledgement checkbox.
5. In-transaction inventory re-validation: locks rows with `SELECT FOR UPDATE`, verifying surplus has not been depleted.
6. Idempotency Key Guard: a cryptographic token (`IDEM-...`) ensures repeated submissions or concurrent requests cannot execute twice or duplicate stock movements.

### 5.5 Immutable Governance Audit Trail & Notifications
- Every workflow milestone (`SUBMIT_FOR_APPROVAL`, `APPROVE_PLAN`, `REJECT_PLAN`, `MODIFY_RECOVERY_PLAN`, `EXECUTE_RECOVERY_PLAN`, `UNAUTHORIZED_EXECUTION_ATTEMPT`) creates an immutable `AuditLog` entry.
- Real-time in-app `Notification` alerts are dispatched to relevant stakeholder roles (`Procurement Approver`, `Supply Chain Manager`, `Warehouse Operator`) without external dependencies.

---

## 6. Local Quick Start (Windows PowerShell)

### Step 1: Run the Application Server

```powershell
& "D:\IQ\.venv\Scripts\python.exe" run.py
```
Open **`http://127.0.0.1:5000`** in your browser.

### Step 2: Running Automated Tests

Run the complete regression suite across all 88 unit and integration tests:

```powershell
& "D:\IQ\.venv\Scripts\python.exe" -m unittest discover -s tests -v
```

To run individual test modules:
```powershell
# Phase 4 Recovery Engine Tests (6 tests)
& "D:\IQ\.venv\Scripts\python.exe" -m unittest tests.test_recovery_engine -v

# Phase 4 Approval & Simulated Execution Workflow Tests (13 tests)
& "D:\IQ\.venv\Scripts\python.exe" -m unittest tests.test_recovery_workflow -v

# Phase 3 Deterministic Risk Engine Tests (12 tests)
& "D:\IQ\.venv\Scripts\python.exe" -m unittest tests.test_risk_engine -v
```

---

## 7. Demo Accounts & Role Permissions

| Role | Username | Password | Phase 4 Permitted Governance & Execution Actions |
|---|---|---|---|
| **Administrator** | `admin` | `DisruptionIQ@2026!` | Superuser oversight; view all queues, override emergency approvals, execute plans, inspect audit logs |
| **Operations Analyst** | `analyst` | `DisruptionIQ@2026!` | Analyze disruptions, generate recovery options, compare trade-offs, create draft recovery plans, submit for approval |
| **Supply Chain Manager** | `manager` | `DisruptionIQ@2026!` | Review operational alternatives, modify draft plans, approve operational stock transfers, execute simulated transfers |
| **Procurement Approver** | `approver` | `DisruptionIQ@2026!` | Review financial & supplier recovery plans, approve/reject spend authorization, request plan revisions |
| **Warehouse Operator** | `warehouse` | `DisruptionIQ@2026!` | Review transfer manifests, execute approved simulated stock movements, acknowledge physical warehouse transfers |

---

## 8. Known Limitations & Phase 4 Operational Guidance

1. **Simulated Execution Environment:** All execution is 100% simulated within the local SQLite database. The system intentionally never contacts commercial carrier APIs, external freight brokers, EDI systems, or financial institutions.
2. **Deterministic Calculations:** Strategy ranking scores, cost estimates, and duration reductions are calculated using deterministic logistics formulas and configured benchmark rates; no unverified AI guesses or financial claims are made.
3. **Inventory Rebalancing:** Simulated stock transfers atomically adjust local database balances (`quantity` and `reserved_quantity`) between source and destination warehouses. These adjustments represent planned operational reallocations.
