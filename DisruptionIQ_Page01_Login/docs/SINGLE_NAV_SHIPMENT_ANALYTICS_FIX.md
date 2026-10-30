# Single navigation and Shipment Monitoring repair

## Navigation correction

The former workspace structure contained repeated sub-navigation bars inside multiple section containers. This patch removes the nested copies and keeps exactly one root-level sub-navigation per workspace: Network Operations, Disruption Intelligence and Recovery Management. The navigation state controller now hides inactive direct child panels and activates the selected panel and its module view. The floating section navigator is hidden for these workspaces to avoid a second competing navigation system.

## Shipment Monitoring activation

Network Operations now defaults to the `network-shipments` panel. The previous route activated the parent workspace but left the shipment module inactive, while `.page-view` styles intentionally hid inactive module views. The new workspace activation path selects the default panel and module together, including on deep links and browser history navigation.

## Database-backed analytics

`GET /api/v1/shipments/overview` now returns SQLite aggregates in `analytics`: `status_distribution`, `carrier_distribution`, `route_distribution`, `risk_distribution`, `transport_distribution` and `created_trend`. The shipment KPI response includes elevated-risk count and average recorded risk score. Carrier and route aggregates include delayed-shipment counts. No chart value is hardcoded in the frontend.

The UI creates charts for shipment status, daily shipment-creation trend, volume by carrier, risk-score bands, top origin-destination corridors and transport mode. Carrier and route charts compare all shipments against delayed shipments. Chart.js tooltips, hover interaction and legends are enabled; the existing local SVG chart fallback remains available when the external Chart.js library cannot be loaded.

The India transit map remains an illustrative network diagram, not GPS tracking. Route-volume chips alongside it are populated from database route aggregates.

## Tests

- `npm test` — all authentication, API, workflow, navigation, simulation, chart fallback and workspace navigation tests pass.
- `node scripts/check.js` — 41 JavaScript files pass syntax checks; Node's `node:sqlite` is available.
- `tests/page07-test.js` — validates shipment totals and chart datasets against direct SQLite queries, tests delayed counts and risk KPIs, checks filtering/pagination/detail/auth contracts, and verifies empty-database behaviour.
- A local server startup and `/health` request were verified on port 4010.
