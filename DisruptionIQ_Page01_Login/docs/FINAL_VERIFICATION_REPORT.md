# DisruptionIQ 10.0 — Final System Rebuild Verification

Verification date: 2026-10-31

## Runtime

- Node.js: v22.16.0
- Runtime: Node.js native HTTP server
- Database: SQLite (`node:sqlite`)
- Frontend: vanilla HTML, CSS and JavaScript
- Verified development URL: `http://127.0.0.1:4010`
- Health response: HTTP 200; service version 7.1.0

## Automated verification

- `npm run check` — PASS; 47 JavaScript files syntax-checked and `node:sqlite` available.
- `npm test` — PASS; authentication, role separation, customer isolation, maker-checker approvals, immutable audit, hub and operational APIs, SQLite aggregate reconciliation, empty-database behavior, risk/simulation, chart fallback, navigation and UI guards.
- `npm run test:dataset` — PASS; imported synthetic dataset relationships, idempotency and database-backed metrics.
- ZIP integrity — PASS (`unzip -t`). The archive excludes `.env`, `node_modules` and pre-existing SQLite files.

## Clean-start database and login smoke test

A fresh database was bootstrapped and the server was started on port 4010. All four demo logins returned the expected role redirects:

- Hub In-Charge → `/app/overview`
- Risk Analyst → `/app/disruption-intelligence`
- Recovery Manager → `/app/recovery-management`
- Customer → `/customer/portal`

Fresh database counts after bootstrap:

- 4 active demo users
- 398 shipments
- 356 suppliers
- 354 warehouses
- 0 foreign-key violations

## Shipment network and analytics

- 13 city nodes with reference coordinates.
- 35 synthetic corridor groups calculated from the shipment register.
- 379 of 398 shipments have mapped Indian endpoints.
- 19 shipments with non-Indian or unknown endpoints remain unmapped rather than receiving fabricated coordinates.
- Shipment KPI and chart aggregates are tested against direct SQLite aggregation queries, including empty-database responses.

## Governance and synthetic provenance

- Hub In-Charge is the plan maker.
- A different Recovery Manager is the independent checker and execution role.
- Risk Analyst can inspect and simulate but cannot approve or execute plans.
- Self-approval is blocked; decision and execution transitions are transaction-safe.
- Audit events are protected against update/delete during application runtime.
- Imported synthetic workbook approvals, audit rows, notifications, carrier events and plan templates are archived as non-actionable reference records.
- The UI contains one synthetic-data provenance banner and no database-connection badge or jury/reviewer control.

## Visual verification boundary

Automated UI tests verify unique DOM IDs, the one-subnavigation-per-workspace rule, active-panel switching, required chart surfaces and fallback chart rendering. Browser screenshot automation was not run, so no pixel-perfect visual claim is made. Chart.js interactivity and OpenStreetMap/Leaflet tiles use external CDN/network resources; chart fallback is available when Chart.js is unavailable, while map tiles require connectivity.

## Operational limitations

The map displays city-centre reference coordinates and synthetic shipment corridors, not GPS tracks, vehicle positions, road-level directions or external route feasibility. Recovery execution is a simulation and does not move physical inventory, book freight or confirm delivery. Risk scoring and scenario analysis are deterministic/advisory and are not calibrated predictive guarantees.

## Start

macOS/Linux:

```bash
PORT=4010 npm start
```

Then open `http://localhost:4010`.
