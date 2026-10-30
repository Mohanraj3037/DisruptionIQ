# Page 08 – Supplier Management

## Scope

Page 08 is an internal, read-only supplier operations module built incrementally on the Page 07 project. It preserves the Node.js native HTTP server, `node:sqlite`, vanilla JavaScript, existing HTML/CSS and Chart.js. No new role, supplier account, duplicate supplier table or write workflow is introduced.

## Inspected database relationships

| From | To | Actual relationship | Page 08 treatment |
|---|---|---|---|
| `suppliers` | `shipments` | `shipments.supplier_id → suppliers.id` | Direct supplier shipment register and shipment KPIs |
| `shipments` | `shipment_items` | `shipment_items.shipment_id → shipments.id` | Item quantities and SKU evidence for supplier-linked shipments |
| `shipment_items` | `products` | `shipment_items.sku → products.sku` (products table is created by the expanded dataset importer) | Products are shown as an indirect association through the supplier's shipments. There is no supplier FK on products and no supplier-products junction table. |
| `disruptions` | `shipments` | `disruptions.shipment_id → shipments.id` | Shipment disruptions are included only when the linked shipment has the supplier FK. |
| `disruptions` | `suppliers` | No FK. Imported supplier-origin events preserve `source_entity_type='SUPPLIER'` and `source_entity_id=suppliers.code`. | Supplier-only events match the exact source type and supplier code. They are not assigned to a shipment or warehouse. |
| `recovery_plans` | `disruptions` | `recovery_plans.disruption_id → disruptions.id` | Plans are included only through the supplier-source disruption or a disruption attached to a supplier-linked shipment. Actions are joined through `recovery_actions.recovery_plan_id`. |
| `disruption_affected_orders` | `disruptions`, `customer_orders` | `disruption_id`, `customer_order_id` | Affected order references/counts are exposed only where this explicit link exists. There is no direct supplier-order FK. |
| `audit_logs` | supplier/linked entities | Polymorphic `entity_type` and `entity_id` text fields | Supplier events and events for verified linked shipment/disruption IDs are included. |

The schema has no dedicated supplier address, phone, product assignment or supplier-to-warehouse relationship. The supplier profile therefore displays only stored country, city, state, region and contact email. `is_active` is the stored status field. Reliability and illustrative risk fields are intentionally not used as Page 08 performance ratings.

## Backend service

New service: `src/services/supplier-service.js`.

The service uses parameterized SQL for all user-supplied values, stable sorting with a supplier ID tie-breaker, bounded pagination and relationship-aware subqueries. It detects the optional `products` table so an empty/pre-import database remains usable. Product quantities are summed from `shipment_items.quantity`; product counts are distinct SKUs, not guessed supplier catalogue assignments.

### Endpoints

All endpoints require an authenticated `HUB_INCHARGE` session. `CUSTOMER` receives HTTP 403.

| Endpoint | Response |
|---|---|
| `GET /api/v1/suppliers/overview` | Database-derived supplier totals, active/inactive counts, shipment/disruption/recovery associations, distinct shipment-linked SKUs, no-activity count, shipment status distribution and disruption status distribution |
| `GET /api/v1/suppliers` | Paginated supplier register |
| `GET /api/v1/suppliers/:id` | Supplier profile, shipment performance, linked products/disruptions/recovery summary and relationship notes |
| `GET /api/v1/suppliers/:id/products` | Paginated distinct SKU list with product metadata when `products` exists, linked shipment count and shipped quantity |
| `GET /api/v1/suppliers/:id/shipments` | Paginated direct supplier-linked shipments with carrier, warehouse, dates and item totals |
| `GET /api/v1/suppliers/:id/disruptions` | Paginated exact supplier-source events and shipment-linked disruptions, with verifiable affected-order references |
| `GET /api/v1/suppliers/:id/recovery` | Paginated verified recovery plans and their actual recovery actions |
| `GET /api/v1/suppliers/:id/activities` | Paginated existing audit records for supplier and verified linked entities |

### Query parameters

Register parameters:

- `page` positive integer, default 1.
- `limit` integer 1–100, default 25.
- `q` searches supplier ID, code and name; maximum 100 characters.
- `status`: `active` or `inactive`.
- `products`, `disruption`, `activity`: optional `yes` or `no` relationship filters.
- `sort`: `id`, `name`, `code`, `shipments`, `products` or `status`.
- `direction`: `asc` or `desc`.

Collection parameters:

- `page` positive integer, default 1.
- `limit` integer 1–100, default 25.
- `q` is supported on products and validated consistently for collections; maximum 100 characters.

Malformed IDs, invalid filters and invalid pagination return HTTP 400. A valid but nonexistent supplier ID returns HTTP 404. SQL sort expressions are selected from fixed allowlists; query values are parameterized.

## Calculation rules

- Active/inactive use `suppliers.is_active` only.
- Supplier shipment totals use `shipments.supplier_id` only.
- Delivered, delayed and in-transit totals use exact stored shipment status values.
- Supplier-linked disruption count includes exact supplier-source events plus disruptions joined through supplier-linked shipments. No unrelated source event is assigned to a supplier.
- Affected shipment count uses active/investigating disruption records with a non-null linked shipment ID, deduplicated by shipment.
- Recovery plans are counted only when their disruption resolves to a supplier by the rules above.
- Products are distinct SKU records represented in shipment items of supplier-linked shipments. Quantity is the sum of those linked shipment item quantities, not a purchase order or supplier capacity estimate.
- Operational activity is based on actual linked shipments and exact supplier-source disruptions. Audit history is limited to persisted records.
- No supplier health score, on-time rate, reliability percentage, location, GPS, lead-time performance or product relationship is synthesized.

## Frontend

- Register route: `/app/suppliers`.
- Detail route: `/app/suppliers/:id`.
- Navigation: Network Operations → Suppliers.
- Summary cards load from the overview API.
- Chart.js shipment status mix uses only supplier-linked shipments. Disruption status counts are rendered from stored relationships.
- Register supports name/code/ID search, active/inactive status, product/disruption/activity relationship filters, sorting, refresh, CSV export and pagination.
- Detail view includes profile, operational summary, Products, Shipments, Disruptions, Recovery and Activity History tabs.
- Supplier-linked shipment rows navigate to the existing Page 07 shipment detail route.
- Browser history supports direct supplier routes and back/forward navigation.
- Existing design tokens, cards, table styles, tabs, pagination and responsive breakpoints are reused. No prior page is redesigned.

## Authorization

The `/app/suppliers` page route is served only to an authenticated employee session. The server's existing employee workspace guard denies Customer page access with HTTP 403. Every supplier API route explicitly calls `requireRole(..., 'HUB_INCHARGE')`; Customers receive HTTP 403. The page is read-only, so no new mutation/CSRF workflow is introduced.

## Test results

- `npm test`: authentication and Pages 04–08 regression/integration tests pass.
- `npm run check`: 23 JavaScript files pass syntax checks; `node:sqlite` is available.
- `npm run test:dataset`: 17 sheets × 350 records import, preserve synthetic provenance and remain idempotent. Page 08 supplier overview, product associations and supplier-only disruption relationships are additionally checked against the imported dataset.
- Browser screenshot/responsive visual regression was not run. Responsive layout uses existing CSS conventions and added breakpoints; this is not a claim of browser-verified appearance.

## Known limitations

1. No direct supplier-product FK or supplier-products table exists. Product associations are shipment-item-derived.
2. Supplier-source disruptions have no shipment or warehouse FK. They are shown against the supplier by preserved source metadata only.
3. No direct supplier-order FK exists. Orders appear only as affected-order references on disruptions with explicit `disruption_affected_orders` links.
4. No supplier-to-warehouse relationship, supplier address/phone or separate supplier activity table exists.
5. Audit history may be empty for suppliers if no matching supplier/linked entity audit rows were recorded.
6. No supplier create/edit/delete workflow is added.
