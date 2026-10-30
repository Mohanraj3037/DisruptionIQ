# DisruptionIQ API Contract (v1)

Base URL during local development: `http://127.0.0.1:3000 (default; use the actual origin printed at startup)`.

The existing supplied frontend compatibility API returns the structure used by `public/js/app.js` at `GET /api/data`. Only login and the five requested modules are exposed by the frontend: Overview Dashboard, Shipment Monitoring, Risk Analysis, Recovery Planning, and Approval & Audit Trail.

All `/api/*` routes except `POST /api/auth/login` require an authenticated session. Mutating requests additionally require `X-CSRF-Token` equal to the `diq_csrf` cookie value. JSON request bodies use `Content-Type: application/json`.

## API groups

| Domain | Endpoints |
|---|---|
| Auth | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`, `GET /api/profile` |
| Overview | `GET /api/data`, `GET /api/dashboard-charts`, `GET /api/v1/dashboard` |
| Logistics | `GET /api/v1/shipments`, `/suppliers`, `/warehouses`, `/inventory`, `/orders` |
| Disruptions | `GET /api/v1/disruptions`, `GET /api/v1/disruptions/:id`, `POST /api/v1/disruptions/scan`, `POST /api/v1/shipments/:id/evaluate`, `GET /api/v1/disruptions/:id/impact`, `GET /api/v1/disruptions/:id/summary` |
| Risk | `GET /api/v1/risk/queue`, `GET /api/v1/orders/:id/risk-explanation`, `POST /api/insights/orders/compare-ranking` |
| Recovery | `GET /api/v1/disruptions/:id/recovery-options`, `POST /api/v1/recovery-plans/from-recommendation`, `GET /api/v1/recovery-plans`, `GET /api/v1/recovery-plans/:id`, `PATCH /api/v1/recovery-plans/:id`, and submit/decision/execute actions |
| Governance | `GET /api/v1/approvals`, `GET /api/v1/audit-logs` |
| Imports | `POST /api/v1/imports` with `{entity, records}` or `{entity, csv}`; set `dry_run: true` to validate without writing |
| Notifications | `GET /api/v1/notifications`, `POST /api/v1/notifications/:id/read` |
| AI insights | `GET /api/insights/disruptions/:id/summary`, `GET /api/insights/orders/:id/risk-explanation`, `GET /api/insights/disruptions/:id/recovery-explanation/:option_id`, `GET /api/insights/disruptions/:id/scenario-comparison`, `POST /api/insights/orders/compare-ranking`, `POST /api/insights/cache/clear` |
| Carrier | `POST /api/webhooks/carrier` with `X-Webhook-Secret`; `POST /api/webhooks/simulator` is for authenticated local simulation |

Responses use JSON. Errors include `{success:false,error:"..."}` or `{error:"..."}`. Paginated collection endpoints accept `limit` (1–200) and `offset`.

## Import request example

```json
{
  "entity": "shipments",
  "dry_run": true,
  "records": [
    {
      "tracking_number": "TRK-001",
      "carrier": "Demo Carrier",
      "origin_city": "Rotterdam",
      "destination_city": "Singapore",
      "destination_warehouse_code": "WH-CENTRAL",
      "unit_count": 120,
      "status": "In Transit"
    }
  ]
}
```

Commit by setting `dry_run` to `false` or omitting it. Imports are limited to shipment and inventory entities. CSV rows use the same field names as JSON records.


## PAGE 01 authentication role contract

Only `HUB_INCHARGE` and `CUSTOMER` are valid roles. Hub In-Charge sessions may access operational APIs and `/app/*`; Customer sessions may access only customer-scoped APIs such as `/api/v1/customer/orders` and `/api/v1/customer/orders/:id`. Customer ownership is resolved from the authenticated session, never from a client-supplied customer ID.


## PAGE 04 – Overview Dashboard

`GET /api/v1/dashboard` is the canonical Overview Dashboard endpoint. It requires an authenticated `HUB_INCHARGE` session; `CUSTOMER` receives HTTP 403. The response contains `data.summary`, `data.shipment_health`, `data.disruption_overview`, `data.order_risk`, `data.recovery_overview`, `data.hub_performance`, `data.recent_activities`, and `data.last_updated`. The original `/api/data` response remains available for existing frontend modules. See [PAGE_04_OVERVIEW.md](PAGE_04_OVERVIEW.md) for KPI definitions, status precedence, synthetic dataset import and test instructions.

## PAGE 05 – Hub Overview & Monitoring

All Page 05 endpoints require a `HUB_INCHARGE` session. `CUSTOMER` receives HTTP 403 from every internal hub endpoint.

- `GET /api/v1/hubs/overview`: network totals, inventory-shortage indicators, recovery-action count, health distribution and update timestamp.
- `GET /api/v1/hubs?page=1&limit=25&q=&status=&health=&disruption=`: warehouse-backed hub listing. `limit` is 1–100; status is `active|inactive`; health is `healthy|watch|critical`; disruption is `active|none`.
- `GET /api/v1/hubs/:id`: one warehouse-backed hub with linked shipment, inventory, active disruption, affected-order and recovery-plan records.
- `GET /api/v1/hubs/:id/activities?limit=20`: audit events whose entity IDs resolve to the hub's shipments, disruptions or recovery plans. `limit` is 1–100.

Page 05 uses `warehouses` as the hub entity. A shipment is counted once per warehouse when the warehouse is its origin or destination. Disruptions are associated only through a direct warehouse FK, a linked shipment's origin/destination warehouse, or a resolvable inventory source record. Supplier-only disruptions remain unassigned. No transfer records or geographic coordinates are synthesized. See [PAGE_05_HUB_MONITORING.md](PAGE_05_HUB_MONITORING.md) for complete response fields, filter validation, calculation rules and limitations.


## Page 06 – Hub Details

See `docs/PAGE_06_HUB_DETAILS.md` for relationship definitions and full response behavior. The following protected GET endpoints are available to `HUB_INCHARGE` only: `/api/v1/hubs/:id`, `/api/v1/hubs/:id/shipments`, `/api/v1/hubs/:id/disruptions`, `/api/v1/hubs/:id/inventory`, `/api/v1/hubs/:id/orders`, `/api/v1/hubs/:id/recovery`, and `/api/v1/hubs/:id/activities`. Collection endpoints support `page`, `limit` (1–100), `q` (up to 100 characters), and `status` (up to 40 characters). Collection response shape: `{ success, hub_id, type, items, total, page, limit, total_pages }`; activities also retains the legacy `activities` alias. Invalid pagination returns 400, unknown warehouse IDs return 404, and Customer requests return 403.


## Page 07 – Shipment Management

- `GET /api/v1/shipments/overview` returns database-derived shipment totals and status counts.
- `GET /api/v1/shipments` returns a stable paginated register. Query parameters: `page`, `limit` (max 100), `q`, `status`, `carrier`, `origin`, `destination`, `from`, `to`, `disruption`, `sort`, and `direction`.
- `GET /api/v1/shipments/:id` returns the shipment, item lines, shipment-linked disruptions, orders linked through those disruptions, recovery plans, and persisted activity events.
- `GET /api/v1/shipments/:id/items`, `/disruptions`, `/recovery`, and `/activities` return the corresponding collections.

All internal shipment APIs require `HUB_INCHARGE`; `CUSTOMER` receives HTTP 403. Malformed IDs and invalid filters/pagination return HTTP 400; missing shipments return HTTP 404. There is no direct shipment-to-order foreign key, so order associations are limited to verified `disruption_affected_orders` links.


## Page 08 – Supplier Management

All `/api/v1/suppliers` endpoints require `HUB_INCHARGE`; `CUSTOMER` receives HTTP 403.

- `GET /api/v1/suppliers/overview`: supplier totals and supplier-linked shipment/disruption status distributions.
- `GET /api/v1/suppliers?page=1&limit=25&q=&status=&products=&disruption=&activity=&sort=name&direction=asc`: supplier register. `limit` is 1–100; `status` is `active|inactive`; relationship filters are `yes|no`; `sort` is `id|name|code|shipments|products|status`; direction is `asc|desc`.
- `GET /api/v1/suppliers/:id`: profile, shipment performance, products, disruptions, recovery summary and relationship notes.
- `GET /api/v1/suppliers/:id/products`, `/shipments`, `/disruptions`, `/recovery`, `/activities`: paginated verified collections (`page`, `limit`, and `q` where relevant).

Supplier shipments use `shipments.supplier_id`. Products are linked indirectly through `shipment_items` for those shipments; no direct supplier-product FK exists. Disruptions are linked either by exact `source_entity_type='SUPPLIER'` and `source_entity_id=suppliers.code`, or by a disruption's shipment FK to a supplier-linked shipment. Recovery plans are linked through those disruptions. Affected orders require explicit `disruption_affected_orders` links. Supplier-only disruptions without shipment or warehouse FKs are never assigned to guessed entities. See [PAGE_08_SUPPLIER_MANAGEMENT.md](PAGE_08_SUPPLIER_MANAGEMENT.md) for response details and calculation rules.

## Page 09 — Warehouse & Inventory Management (Hub In-Charge only)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/inventory/overview` | Warehouse/inventory KPI summary, stock distribution and warehouse record footprint |
| GET | `/api/v1/warehouses?page=&limit=&q=&status=&location=&disruption=&sort=&direction=` | Filtered warehouse register |
| GET | `/api/v1/warehouses/:id` | Warehouse identity and verified operational summary |
| GET | `/api/v1/warehouses/:id/inventory?page=&limit=&q=&status=&product=` | Warehouse inventory rows and derived stock state |
| GET | `/api/v1/warehouses/:id/shipments?page=&limit=&q=` | Shipments where the warehouse is origin or destination, without duplicates |
| GET | `/api/v1/warehouses/:id/disruptions?page=&limit=&q=` | Direct and verified shipment/inventory-related disruptions |
| GET | `/api/v1/warehouses/:id/orders?page=&limit=&q=` | Assigned or explicitly disruption-affected orders |
| GET | `/api/v1/warehouses/:id/recovery?page=&limit=&q=` | Recovery plans attached to verified related disruptions |
| GET | `/api/v1/warehouses/:id/activities?page=&limit=&q=` | Existing audit activities for the warehouse and linked entities |
| GET | `/api/v1/inventory?page=&limit=&q=&status=` | Global paginated inventory register (legacy-compatible response key `inventory`) |
| GET | `/api/v1/inventory/:id` | Inventory record and its warehouse/product details |
| GET | `/api/v1/products/:id/inventory` | Warehouse-level inventory for a known product identifier, when products are available |

All endpoints require an authenticated `HUB_INCHARGE` session. Customer requests return HTTP 403. Pagination limits are 1–100. Invalid filters and pagination return HTTP 400; missing warehouse/inventory/product identifiers return HTTP 404 where applicable.


## Page 10: Customer Order Management

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/v1/orders/overview` | HUB_INCHARGE |
| GET | `/api/v1/orders` | HUB_INCHARGE |
| GET | `/api/v1/orders/:id` | HUB_INCHARGE |
| GET | `/api/v1/orders/:id/items` | HUB_INCHARGE |
| GET | `/api/v1/orders/:id/shipments` | HUB_INCHARGE |
| GET | `/api/v1/orders/:id/disruptions` | HUB_INCHARGE |
| GET | `/api/v1/orders/:id/risk` | HUB_INCHARGE |
| GET | `/api/v1/orders/:id/recovery` | HUB_INCHARGE |
| GET | `/api/v1/orders/:id/activities` | HUB_INCHARGE |

Register filters: `page`, `limit`, `q`, `status`, `risk`, `disruption`, `warehouse`, `from`, `to`, `sort`, `direction`. Shipment associations are derived exclusively from `disruption_affected_orders` → `disruptions.shipment_id`. Risk is computed by the existing deterministic risk engine and may be unavailable where no active disruption link exists. The separate `/api/v1/customer/orders` routes retain customer ownership filtering.

## Primary page navigation

The frontend now exposes five Hub In-Charge primary routes:

- `GET /app/overview`
- `GET /app/network-operations`
- `GET /app/disruption-intelligence`
- `GET /app/recovery-management`
- `GET /app/intelligence-administration`

These routes serve the existing authenticated application shell. They do not introduce new business APIs or database entities. Existing module routes remain backward-compatible: `/app/hub-overview`, `/app/hub-details`, `/app/shipments`, `/app/suppliers`, `/app/warehouses`, `/app/orders`, `/app/risk`, `/app/recovery`, and `/app/audit`.

The notification badge and notification section reuse `GET /api/v1/notifications`; marking a notification read reuses `POST /api/v1/notifications/:id/read`. Existing session and CSRF controls remain authoritative.
