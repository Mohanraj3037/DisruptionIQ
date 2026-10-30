# PAGE 04 – Overview Dashboard

## Architecture inspection

The current application is Node.js native HTTP + SQLite (`node:sqlite`) + vanilla HTML/CSS/JavaScript + Chart.js. It is not a Flask/SQLAlchemy/PostgreSQL/Neon application. This implementation keeps that architecture and extends the existing `GET /api/v1/dashboard` route.

The existing `/api/data` route remains available as a compatibility contract for the existing multi-page frontend. The Overview page now loads `/api/v1/dashboard`.

## Inspection checklist

| Area | State | Notes |
|---|---|---|
| Authentication | Implemented | Exactly `HUB_INCHARGE` and `CUSTOMER`; customer is blocked from `/app/*` and internal APIs. |
| Operational database | Implemented | SQLite tables cover suppliers, warehouses, inventory, shipments, orders, disruptions, recovery, approvals, audit, webhooks and notifications. |
| Dashboard API | Extended | `/api/v1/dashboard` returns the full dashboard sections and preserves the prior top-level `summary` property. |
| KPI calculations | Implemented | Calculated from persisted database rows. |
| Shipment health | Implemented | Status distribution is mutually exclusive and includes an extra `Scheduled` bucket so all shipments are accounted for. |
| Disruption overview | Implemented | Active + investigating incidents, severity/type distributions, affected shipment/order counts and recent incident details. |
| Order risk | Implemented | Existing deterministic risk engine; deduplicates orders by their highest current score across active disruptions. |
| Recovery overview | Implemented | Uses recovery plan, action and approval states. |
| Hub performance | Implemented where relationships exist | A warehouse is treated as a hub. Shipment destination, disruption, affected-order and recovery-action relationships are used. |
| Recent activities | Implemented | Combines audit records, notifications and carrier webhook events. |
| Geographic map | Not supported by schema | The current model has no hub coordinates. The overview therefore displays hub performance rows instead of inventing map positions. |

## API

### `GET /api/v1/dashboard?days=7`

Optional `days` query parameter controls the disruption trend window (1–30 days; the UI exposes 7 and 14 days). Refresh always re-queries the database.

Authentication: required. Authorization: `HUB_INCHARGE` only. A `CUSTOMER` receives HTTP 403.

Response envelope:

```json
{
  "success": true,
  "data": {
    "summary": {},
    "shipment_health": {},
    "disruption_overview": {},
    "order_risk": {},
    "recovery_overview": {},
    "hub_performance": [],
    "recent_activities": [],
    "last_updated": "2026-10-30T13:00:00.000Z"
  },
  "summary": {},
  "last_updated": "2026-10-30T13:00:00.000Z"
}
```

The `data` object also retains the existing frontend compatibility collections: `overview`, `incidents`, `shipments`, `suppliers`, `recoveryPlans`, `approvals`, and `auditTrail`.

### KPI definitions

| Metric | Calculation |
|---|---|
| Total Shipments | `COUNT(*)` from `shipments`. |
| In-Transit Shipments | Shipments whose persisted `status` is exactly `In Transit`. |
| Delivered Shipments | Shipments whose persisted `status` is exactly `Delivered`. |
| Delayed Shipments | Shipments whose persisted `status` is exactly `Delayed`. |
| Active Disruptions | Distinct disruption rows whose status is `Active` or `Investigating`. |
| Affected Customer Orders | Distinct orders linked through `disruption_affected_orders` to an active or investigating disruption. |
| High-Risk Orders | Unique affected orders classified `Critical` or `High` by the deterministic risk engine. If an order is linked to multiple active disruptions, its highest current score is used once. |
| Recovery Plans in Progress | Distinct plans in `Approved`, `Execution Ready`, or `Executing` states. |
| Pending Approvals | Distinct recovery plans with an approval row in `Pending` state. |
| Successfully Recovered Orders | Distinct `customer_order_id` values on `Executed` plans with a non-null execution result. |

All metrics return numeric zero for empty tables.

### Shipment health

The distribution is mutually exclusive and uses this precedence:

1. Delivered
2. Delayed
3. Disrupted (an active disruption is linked to the shipment)
4. At Risk (explicit `ui_status` of At Risk or persisted shipment risk score at least 60)
5. In Transit
6. Scheduled (remaining statuses, including pending pickup)

The extra Scheduled bucket prevents shipment records from disappearing from the chart. The KPI `In-Transit Shipments` remains a direct count of the persisted `In Transit` status. Consequently, an in-transit shipment classified as Disrupted in the mutually exclusive chart is still included in the direct in-transit KPI.

### Disruption overview

Active means `Active` or `Investigating`. Severity and type distributions use only active disruptions. Affected shipments count distinct non-null `shipment_id` values. Affected orders count distinct rows in `disruption_affected_orders`. Recent disruption records include detection timestamp, severity, type, linked shipment, hub where available, affected order count and synthetic provenance.

### Order risk

The existing deterministic risk engine is the only source of risk levels. AI-generated text is not used to calculate risk. The existing 35/30/20/15 weighted deterministic formula remains in place. Dashboard classification uses one maximum current risk score per distinct affected order. The response includes counts for all four severity bands and up to ten order summaries per band; customer names are omitted from the dashboard risk payload.

### Recovery overview

- Awaiting approval: plans in `Pending Approval`.
- Approved plans: plans in `Approved`.
- Actions in progress: action status `In Progress` or `Executing`.
- Completed actions: action status `Completed`.
- Failed/blocked actions: action status `Failed` or `Blocked`.
- Mitigation coverage: distinct affected orders with a linked plan in `Pending Approval`, `Approved`, `Execution Ready` or `Executed`, divided by distinct affected orders.

An approved plan is not counted as an action currently executing unless its action row is actually in an in-progress state.

### Hub performance

There is no separate `hubs` table. The current schema's `warehouses` are used as operational hubs. Shipment counts use `shipments.destination_warehouse_id`; disruptions use `disruptions.warehouse_id` or their linked shipment destination; affected orders use the disruption-order relation; recovery progress uses linked recovery action states. Supplier disruptions in the workbook do not identify a shipment or hub, so the importer preserves their supplier source type/ID and deliberately leaves shipment/hub references null. No geographic coordinates or unsupported hub relationships are fabricated.

### Recent activities

The feed merges the latest audit log rows, notifications and webhook events, then sorts by event timestamp. Each event includes a type, description, timestamp, entity type/identifier, status when available, actor and `is_synthetic`.

## Synthetic workbook import

The uploaded workbook is bundled as `data/expanded-synthetic-dataset-v2.json` after normalization. Run:

```bash
npm run import:expanded-dataset
```

The importer is opt-in and transactional. It expects 350 rows in each of the 17 entity collections, validates linked IDs, uses source IDs as stable unique codes, marks imported records `data_origin='synthetic'`, and writes a one-time import marker to prevent duplicate insertion.

The importer adds normalized `products`, `carriers` and `source_order_risks` reference tables because the current operational schema does not have those exact entities. It retains shipment/inventory source record IDs, carrier codes and disruption source entity type/ID so workbook relationships can be validated without guessing. Workbook order items do not include line-level selling prices, so imported rows set `unit_price_available=0`; the supplied order-level `order_value_inr` is preserved as the order total. Workbook recovery plans include `estimated_recovery_days`, which is stored separately rather than being misrepresented as delay-reduction hours. The workbook has no recovery-actions sheet, so the importer does not fabricate recovery action rows. Supplied workbook risk scores are retained in `source_order_risks` as illustrative source data only; dashboard risk levels are recalculated by the deterministic risk engine.

Workbook user records are imported as inactive `HUB_INCHARGE` records. They cannot authenticate, and the application's only active role values remain `HUB_INCHARGE` and `CUSTOMER`. Synthetic approval and audit actor references are retained through these inactive users. Synthetic approvals are not a substitute for production authorization; execution still requires the application's approval-version checks, separation-of-duties checks and explicit execution confirmation.

Imported dataset records are additive to existing seed records. Running the importer again reports that the dataset was already imported and creates no duplicate rows.

## Frontend integration

- The existing layout, sidebar, header, card styles, typography, colors and chart styling are retained.
- The four main KPI cards and six compact KPI tiles now show the ten requested metrics.
- The shipment completion gauge uses delivered versus remaining shipment counts.
- Disruption velocity uses database detection/resolution timestamps.
- Regional exposure uses supplier risk scores or a deterministic reliability-derived fallback.
- The hub panel displays actual warehouse-linked performance. No coordinates are inferred.
- Recent disruption titles expand to fetch the existing disruption detail endpoint.
- KPI cards navigate only to existing routes: Shipment Monitoring, Risk Analysis, Recovery Planning and Approval & Audit.
- Refresh reloads `/api/v1/dashboard` and updates the last-updated timestamp.
- Synthetic records are labelled in the environment banner and event details.

## Tests

Run:

```bash
npm run check
npm test
npm run test:dataset
```

`npm test` verifies dashboard KPI calculations against direct SQLite counts, empty database handling, live refresh behavior and Customer 403 authorization in addition to the existing authentication/recovery smoke tests.

`npm run test:dataset` verifies 350 records in each of the 17 workbook entities, foreign-key integrity, inactive synthetic user handling, four-role enforcement, idempotent import and dashboard metrics from the imported database.

## Known limitations

- Geographic mapping is not possible until the schema contains validated hub latitude/longitude fields.
- The workbook contains no executed recovery plans, so successfully recovered orders correctly remain zero until a recovery execution is recorded.
- Shipment health has an additional Scheduled bucket beyond the five requested categories so the chart accounts for all shipment rows.
- The importer is a local SQLite demonstration-data import. It does not create a PostgreSQL/Neon migration or change the production shared-schema ownership model.
