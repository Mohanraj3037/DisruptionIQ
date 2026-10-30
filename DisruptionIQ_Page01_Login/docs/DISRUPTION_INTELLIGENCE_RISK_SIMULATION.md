# Disruption Intelligence: Risk Prioritisation and Scenario Simulation

## Scope

This batch extends the existing Node.js native HTTP + SQLite + vanilla JavaScript application. It preserves the two roles (`HUB_INCHARGE`, `CUSTOMER`) and the five primary Hub navigation destinations. Both new workspaces live inside `/app/disruption-intelligence`.

## Risk APIs

- `GET /api/v1/risks/overview`: distinct customer-order counts by deterministic risk severity, plus unassessed orders.
- `GET /api/v1/risks`: deterministic risk register. Optional `q` and `severity` filters.
- `GET /api/v1/risks/heatmap`: severity by contributing-factor counts. A cell counts orders with the factor score at least 50; the same order may occur in multiple factor columns.
- `GET /api/v1/risks/:orderId?disruption_id=:id`: returns the existing risk-engine assessment and its factor evidence.

The risk engine in `src/domain/risk-engine.js` remains authoritative. Risk is calculated only for explicit `disruption_affected_orders` associations to active or investigating disruptions. Shipments are not assigned invented risk scores; the API reports that metric as unavailable.

## Simulation APIs

- `GET /api/v1/scenarios`: returns valid shipment, supplier and warehouse targets.
- `POST /api/v1/simulations`: validates and evaluates a hypothetical scenario, then saves its input and result.
- `GET /api/v1/simulations`: returns saved simulation history.
- `GET /api/v1/simulations/:id`: returns one saved simulation.
- `POST /api/v1/simulations/compare`: compares two to four saved simulation outputs.

Supported scenario types: `SHIPMENT_DELAY`, `ROAD_ACCIDENT`, `SEVERE_WEATHER`, `SUPPLIER_DISRUPTION`, `WAREHOUSE_DISRUPTION`, `INVENTORY_SHORTAGE`, `CARRIER_DISRUPTION`, and `CUSTOM`.

Simulation persistence uses the additive `simulation_runs` table. It stores creator, scenario type, assumptions, result, timestamp and `simulated` provenance. No existing operational table is changed by simulation evaluation. The result explicitly identifies missing relationships or unsupported route/damage information rather than guessing.

## Security

All APIs are behind the existing authenticated Hub API boundary. Customers receive HTTP 403. Mutating simulation creation and comparison require the existing CSRF validation. No additional login roles or top-level navigation destinations were introduced.

## UI

The Disruption Intelligence primary page retains five scroll sections: command centre, disruption monitoring, impact analysis, risk prioritisation and scenario simulation. The risk register supports search, severity filtering and CSV export. Heatmap cells filter the register. Simulation history supports selecting and comparing saved scenarios.

## Tests

`tests/intelligence-test.js` covers risk overview/register/heatmap, validation, simulation persistence, comparison, customer 403 responses, and verifies that shipment status, order status and inventory quantities remain unchanged after simulation.
