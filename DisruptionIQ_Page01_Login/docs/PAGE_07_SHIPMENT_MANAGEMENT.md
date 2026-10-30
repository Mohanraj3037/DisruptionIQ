# Page 07 – Shipment Management

## Repository inspection

The Page 06 baseline already had a protected `GET /api/v1/shipments` endpoint and a Shipment Monitoring view. The old list endpoint filtered a fully loaded in-memory list and returned the previous compatibility response; the view rendered shipment values from the Page 04 dashboard projection rather than a dedicated shipment register. No dedicated shipment detail endpoint or shipment detail panel existed.

The existing schema is retained. Relevant relationships:

- `shipments.origin_warehouse_id` and `shipments.destination_warehouse_id` reference `warehouses.id`.
- `shipments.carrier_code` references the imported `carriers.carrier_code` logically; `shipments.carrier` remains the fallback display value. The carrier table is created idempotently in the base schema and by the existing importer.
- `shipment_items.shipment_id` references `shipments.id`.
- `disruptions.shipment_id` references `shipments.id`.
- Recovery plans link through `recovery_plans.disruption_id` to a shipment-linked disruption. Actions and approvals link to their recovery plan.
- There is no direct shipment-to-customer-order foreign key. Orders are returned only when linked by `disruption_affected_orders` to a disruption whose `shipment_id` is the selected shipment. No order is guessed from shipment item SKU or warehouse assignment.
- Audit events are included when `entity_type='Shipment'` and `entity_id` matches the shipment ID. Carrier webhook events are included only when their stored payload contains the exact tracking number.

## Backend

Added `src/services/shipment-service.js` and extended the existing shipment routes in `server.js`.

### Endpoints

All routes require an authenticated `HUB_INCHARGE` session. The existing global employee API guard returns HTTP 403 for `CUSTOMER` before these handlers run.

| Method and route | Response |
|---|---|
| `GET /api/v1/shipments/overview` | Database-derived shipment summary, supported status values and update timestamp |
| `GET /api/v1/shipments` | Paginated register, applied filters and available carrier/warehouse/status filter options |
| `GET /api/v1/shipments/:id` | Shipment, items, disruptions, verified affected orders, recovery plans and available activities |
| `GET /api/v1/shipments/:id/items` | Shipment item rows |
| `GET /api/v1/shipments/:id/disruptions` | Shipment-linked disruption rows |
| `GET /api/v1/shipments/:id/recovery` | Recovery plans linked through shipment disruptions |
| `GET /api/v1/shipments/:id/activities` | Available audit and carrier webhook history |

### Register query parameters

- `page` (default 1), `limit` (default 25, maximum 100)
- `q` searches shipment ID and tracking number
- `status` exact stored shipment status
- `carrier` exact carrier display name
- `origin` and `destination` warehouse IDs
- `from` and `to` date filters on actual departure, then estimated departure, falling back to shipment creation date
- `disruption=yes|no` filters active shipment-linked disruptions
- `sort=created|id|tracking|status|eta`, `direction=asc|desc`

Invalid filters or pagination return HTTP 400. A malformed shipment ID returns 400 and a valid but missing shipment ID returns 404. Results use stable secondary ordering by shipment ID.

## Frontend

The existing `/app/shipments` route is now Page 07 Shipment Management. It retains the established layout, chart/card/table styling and navigation. Summary cards and the shipment mix chart use actual database totals. The historical delivery trend panel explicitly reports unavailable because the current schema does not contain a daily delivery history series.

The register supports search, stored-status filter, carrier, origin, destination, date range, disruption association, stable sorting, pagination, refresh and CSV export of the current returned page. Selecting a shipment opens a shared inline detail panel from the register or Page 06 shipment collection. Browser history preserves the selected shipment ID.

## Data provenance and limitations

- `data_origin` is returned per shipment and displayed as operational or synthetic.
- The existing expanded synthetic dataset is reused. No import is triggered by Page 07.
- No GPS coordinates, live checkpoints, external carrier lookups, real-time ETA, delivery trend points or missing recovery actions are generated.
- Carrier events are shown only when matching persisted webhook records exist.
- The current model has no direct shipment-order relation; only disruption-affected-order links are used.
- Shipment-level disruption association is based on `disruptions.shipment_id`. Warehouse-level or supplier-only disruptions are not silently assigned to a shipment.

## Testing

`npm run check` validates JavaScript syntax. `npm test` runs the existing Page 01/four-role, Page 04, Page 05, Page 06 and Page 07 suites. Page 07 tests compare overview counts and detail relationships against direct SQLite queries, validate search, pagination and invalid inputs, and verify Customer denial. `npm run test:dataset` remains available for the existing synthetic importer regression.

Browser screenshot/visual regression is not claimed as performed in this build.
