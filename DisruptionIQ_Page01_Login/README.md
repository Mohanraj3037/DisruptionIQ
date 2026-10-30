# DisruptionIQ 10.0 — Supply-chain Intelligence & Recovery Simulation

DisruptionIQ is a Node.js and SQLite supply-chain intelligence demonstration application. It combines shipment monitoring, supplier and warehouse operations, risk analysis, what-if simulation, recovery planning, independent approvals, audit history and a customer portal. Operational demo records are synthetic fixtures; the application is not connected to live carrier telemetry or GPS.

## Requirements

- Node.js 22.13 or newer (Node 24 is supported).
- No additional `npm install` is required for the Node-native backend.
- Internet access enables the full Chart.js and OpenStreetMap/Leaflet experience. A local chart fallback remains available when the chart CDN cannot load; map tiles require an internet connection.

## Run on port 4010

macOS / Linux:

```bash
PORT=4010 npm start
```

Windows CMD:

```cmd
set PORT=4010 && npm start
```

Open `http://localhost:4010`. Startup bootstraps the expanded synthetic dataset, the India city network, non-actionable historical reference fixtures and saved what-if examples. Bootstrap steps are designed to be repeatable. If port 4010 is already occupied, stop the older DisruptionIQ process before starting this build.

## Development demo accounts

These four accounts are seeded only outside production. Passwords are stored as scrypt hashes and are not prefilled or embedded in the login page.

| Role | Email | Password |
|---|---|---|
| Hub In-Charge | `hub@disruptioniq.local` | `Hub@DIQ2026!` |
| Risk Analyst | `risk@disruptioniq.local` | `Risk@DIQ2026!` |
| Recovery Manager | `recovery@disruptioniq.local` | `Recover@DIQ2026!` |
| Customer | `customer@disruptioniq.local` | `Customer@DIQ2026!` |

Override development passwords with `DEMO_HUB_PASSWORD`, `DEMO_RISK_PASSWORD`, `DEMO_RECOVERY_PASSWORD` and `DEMO_CUSTOMER_PASSWORD` before running bootstrap. These credentials are for local demonstration only and must never be reused in production. Production mode does not seed these accounts.

## Roles, visible pages and permissions

| Role | Pages/workspaces shown | Allowed actions |
|---|---|---|
| **Hub In-Charge** | Overview Dashboard; Shipment Monitoring (hub overview/details, shipments, suppliers, inventory, customer orders); Risk Analysis (overview, incidents, impact, risk register, what-if); Recovery Planning (overview, recommendations, plans, execution); Approval & Audit Trail (queue visibility, audit log, data imports, integrations, notifications). | Run disruption scans; inspect operational relationships; create/edit recovery drafts; submit plans to the Recovery Manager; process approved synthetic carrier webhooks. Cannot approve or execute own plans. |
| **Risk Analyst** | Overview Dashboard; Shipment Monitoring; Risk Analysis (overview, incidents, impact, risk register, what-if scenarios). | Inspect exposure, run synthetic scans and save/compare simulations. Cannot access Recovery Planning or Approval & Audit Trail and cannot create, approve or execute plans. |
| **Recovery Manager** | Overview Dashboard; Shipment Monitoring; Risk Analysis; Recovery Planning (overview, recommendations, plans, approvals and execution); Approval & Audit Trail. | Independently approve, reject or request changes to submitted plans; execute approved plans in simulation mode; review audit and notification history. Cannot create/submit maker drafts or approve their own work. |
| **Customer** | Customer Portal only. | View orders and updates linked to the authenticated customer account. Cannot access internal workspaces or another customer's records. |

Navigation visibility and every protected page/API are role-enforced on the server. Hiding a menu item is not the security boundary.

The requester cannot approve their own plan. The seeded Plans board includes clearly marked `DEMO DRAFT` templates only; there are no pre-approved or pre-executed sample plans. Editing or submitting a draft promotes it into the operational maker-checker workflow. Approval and execution actions are transaction-safe and record the actor, state, timestamp and comments. Audit events are append-only during application runtime. Customer APIs derive the customer scope from the authenticated session, not a client-supplied customer ID.

Notifications appear in the bell menu and the Notifications workspace. The unread badge is refreshed on login and after scans, plan submissions, decisions and simulated execution. The user can open a notification and mark it read; notifications are filtered to the signed-in user or their role, and customers receive only order-linked updates for their own account.

## Navigation and interface

There is one main navigation bar and one contextual sub-navigation for the active workspace. Risk Analysis, Recovery Planning and Shipment Monitoring use a shared switch-panel pattern; changing a subpage replaces the visible content instead of stacking another copy of the pill navigation. The UI does not display a database-connection badge or jury/reviewer controls. A single synthetic-data banner explains the provenance of the demonstration records.

## Shipment analytics and geographic map

Shipment KPIs, carrier and route metrics, status distribution, risk bands, shipment-creation trends and movement summaries are queried from the shared SQLite database. The charts reconcile against direct SQL aggregation tests and handle empty-database results.

The Hub Details route resolves the first warehouse-backed hub when opened without an `?id=` parameter; all six linked detail collections use the `/api/v1/hubs/:id/...` routes. Inventory charts are initialized after the warehouse tab becomes visible to avoid zero-width canvas rendering.

The network map uses OpenStreetMap/Leaflet tiles and city-centre reference coordinates matched to the shipment and warehouse city fields. The seed network has 13 city nodes and 35 synthetic route groups; the clean demo fixture contains 398 shipments. In the current seed, 379 shipments have mapped Indian endpoints and 19 records with non-Indian/unknown endpoints remain explicitly unmapped. Dotted lines represent synthetic city-to-city shipment corridors; they are not road navigation, live GPS tracks or vehicle positions. OpenStreetMap attribution is displayed on the map.

## Data provenance and governance

- Operational records created by the demo bootstrap are synthetic and labelled as such.
- Imported spreadsheet approvals, audit entries, notifications, carrier callbacks and recovery-plan templates are archived as non-actionable synthetic reference records; they do not become live approvals or application audit events.
- Live maker-checker approvals are created through the application workflow. Hub In-Charge submits; a different Recovery Manager decides. Risk Analyst can inspect and simulate but cannot approve or execute.
- Recovery execution is a human-confirmed simulation. It may update the local SQLite stock ledger according to the selected supported action, but it does not move physical inventory, book freight or confirm delivery.
- Unknown or non-Indian map locations remain unmapped; the application does not assign fabricated coordinates.

## Backend and API

- Node.js native HTTP server using built-in `node:sqlite`.
- Vanilla HTML, CSS and JavaScript frontend.
- scrypt password hashes; random server-side session tokens stored as SHA-256 hashes.
- HttpOnly/SameSite cookies, CSRF validation for mutations, same-origin login checks, account-active checks and login throttling.
- Server-side role enforcement on page routes and privileged APIs.
- Customer-to-order ownership enforced in SQL predicates.
- `/health` exposes service runtime information. The UI intentionally does not display a database-connection status badge.

Core API groups include:

- `/api/v1/auth/*` — login, current session and logout.
- `/api/v1/dashboard` and `/api/v1/hubs/*` — overview and hub monitoring.
- `/api/v1/shipments/*` — shipment overview, register, details and geography aggregates.
- `/api/v1/suppliers/*`, `/api/v1/warehouses/*`, `/api/v1/inventory/*` and `/api/v1/orders/*` — operational records and linked details.
- `/api/v1/intelligence/*`, `/api/v1/disruptions/*` and simulation endpoints — incident, risk and what-if workspaces.
- `/api/v1/recovery-plans/*`, `/api/v1/approvals` and `/api/v1/audit-logs` — maker-checker governance and traceability.
- `/api/v1/customer/orders/*` — customer-scoped portal data.

## Quality checks

Run these commands from the project directory:

```bash
npm run check
npm test
npm run test:dataset
```

`npm run check` checks JavaScript syntax across the application and test files. `npm test` runs authentication, role enforcement, customer isolation, maker-checker, audit immutability, hub/shipment/supplier/warehouse/order API, SQL aggregation, empty-database, simulation, navigation and chart-fallback regression tests. The shipment tests compare each chart dataset and KPI with direct SQLite queries, including the empty-database case.

## Project documentation

- `docs/API_CONTRACT.md` — API contracts.
- `docs/DISRUPTION_INTELLIGENCE_RISK_SIMULATION.md` — risk and simulation logic.
- `docs/PAGE_07_SHIPMENT_MANAGEMENT.md` — shipment workspace and data relationships.
- `docs/PAGE_08_SUPPLIER_MANAGEMENT.md` — supplier workspace.
- `docs/PAGE_09_WAREHOUSE_INVENTORY.md` — warehouse and inventory workspace.
- `docs/PAGE_10_ORDER_MANAGEMENT.md` — customer order workspace.
- `docs/HACKATHON_DEMO_GUIDE.md` — demo walkthrough.
- `START_HERE.txt` — short start guide and demo credentials.

## Important limitations

This is a synthetic-data demonstration build. It does not provide real-world prediction guarantees, live carrier integrations, external route feasibility, road-level directions, GPS telemetry or physical execution. Risk scoring is deterministic and explainable from its documented factors; scenario outputs are illustrative comparisons rather than calibrated probabilities or verified financial-loss forecasts.
