# PAGE 01 – Login and Four-Role Authentication

## Confirmed architecture

The repository uses a Node.js native HTTP server, SQLite (`node:sqlite`) and vanilla HTML/CSS/JavaScript. This implementation extends that stack and does not create a second database or silently migrate to a different framework.

## Role model

| Role | Experience | Login destination |
|---|---|---|
| `HUB_INCHARGE` | Operational workspace; creates and submits recovery plans | `/app/overview` |
| `RISK_ANALYST` | Risk analysis and what-if simulations; cannot approve or execute plans | `/app/disruption-intelligence` |
| `RECOVERY_MANAGER` | Independent approval, rejection, change requests and simulated execution | `/app/recovery-management` |
| `CUSTOMER` | Customer-scoped mobile portal | `/customer/portal` |

Legacy employee accounts imported from demo workbooks are disabled during development bootstrap. Historical spreadsheet approvals and audit rows are archived as non-actionable synthetic reference records; they are not placed in the live approval queue.

## Authentication implementation

- `POST /api/v1/auth/login` with legacy alias retained.
- `GET /api/v1/auth/me` with legacy alias retained.
- `POST /api/v1/auth/logout` with legacy alias retained.
- Passwords use native scrypt hashes; credentials are not embedded in login HTML or frontend JavaScript.
- Sessions use random opaque tokens, with only token hashes stored in SQLite.
- Session cookie is HttpOnly and SameSite=Lax; Secure is enabled in production.
- Default session expiry is eight hours; remember-device expiry is thirty days.
- CSRF token required for logout and authenticated mutations.
- Same-origin validation, generic invalid-credential responses, inactive-account checks and IP-based login throttling.
- Backend role enforcement applies to page routes and every privileged API.
- Customer role is denied employee workspaces and operational APIs.

## Customer isolation

The seeded development customer is `CUS-DEMO-001` / Asterion Mobility. Its user account has a `customer_id` and is linked to synthetic orders. Customer order APIs derive ownership from the authenticated session and never trust a client-supplied customer ID. A foreign order returns 404.

## Development demo accounts

| Role | Email | Password |
|---|---|---|
| Hub In-Charge | `hub@disruptioniq.local` | `Hub@DIQ2026!` |
| Risk Analyst | `risk@disruptioniq.local` | `Risk@DIQ2026!` |
| Recovery Manager | `recovery@disruptioniq.local` | `Recover@DIQ2026!` |
| Customer | `customer@disruptioniq.local` | `Customer@DIQ2026!` |

Accounts are seeded only outside production. Passwords are stored as scrypt hashes. Override development passwords with `DEMO_HUB_PASSWORD`, `DEMO_RISK_PASSWORD`, `DEMO_RECOVERY_PASSWORD` and `DEMO_CUSTOMER_PASSWORD`. Never use these demonstration credentials in production.

## Maker-checker governance

Hub In-Charge is the maker. Recovery Manager is the independent checker and execution role. A requester cannot approve their own plan. Decisions and execution are transaction-safe and record actor, state, timestamp and comments. Audit events are append-only during application runtime. Risk Analyst can inspect and simulate but cannot approve or execute recovery plans.

## Files changed

- `server.js`: four role constants, redirects, page/API route enforcement, login/logout audit events and immutable audit triggers.
- `src/database.js` and `src/password.js`: additive schema compatibility, idempotent four-account seed and dependency-free scrypt hashing.
- `src/security.js`: role enforcement, session and customer identity handling.
- `src/domain/recovery-engine.js`: maker-checker rules, transaction-safe approval and simulated execution.
- `src/services/shipment-service.js`: SQLite shipment metrics, analytics and mapped city/corridor data.
- `public/app.html`, `public/js/app.js` and workspace scripts/styles: one contextual sub-navigation per workspace and database-backed shipment analytics.
- `scripts/bootstrap.js`, `scripts/ensure-india-network.js` and `scripts/normalize-demo-governance.js`: idempotent synthetic data bootstrap, geographic fixture coverage and governance-history normalization.
- Regression tests for role separation, approvals, audit immutability, customer isolation, page APIs, shipment aggregation and navigation.

## Verification

Run `npm run check` and `npm test`. The current suite verifies four active demo accounts and hashed passwords, role-specific redirects and access, self-approval prevention, independent Recovery Manager approval and simulated execution, append-only audit behavior, customer-order isolation, shipment metrics against direct SQLite aggregations, empty-database behavior, map node/corridor coverage and unique single-subnavigation DOM mounts.

## Scope boundary

Shipment map points are city-centre reference coordinates and route lines are synthetic corridors derived from the synthetic shipment register. They are not live GPS positions, road directions or carrier telemetry. Recovery execution is simulated and does not move physical inventory or place external carrier orders.
