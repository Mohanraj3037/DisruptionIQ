# Page 10: Customer Order Management

## Scope and architecture

Page 10 extends the existing DisruptionIQ Node.js native HTTP server, SQLite (`node:sqlite`), vanilla JavaScript, existing HTML/CSS and Chart.js application. It is an internal, read-only order-management view. It does not create or modify orders, items, shipment allocations, customer records or recovery plans.

The physical order table is `customer_orders` (there is no `orders` table). Order items are stored in `order_items`.

## Verified database relationships

- `customer_orders.customer_id` references `customers.id` and is the ownership relationship used by the separate customer portal.
- `order_items.order_id` references `customer_orders.id`.
- `customer_orders.assigned_warehouse_id` references `warehouses.id`.
- `disruption_affected_orders.customer_order_id` references `customer_orders.id`; its `disruption_id` references `disruptions.id`.
- `disruptions.shipment_id` references `shipments.id`. Therefore an order-to-shipment association is returned only through `disruption_affected_orders` → `disruptions.shipment_id` → `shipments`. There is no direct shipment/order foreign key or order-shipment allocation table in this application's SQLite schema.
- `recovery_plans.customer_order_id` can directly reference an order. Plans can also be associated through a disruption that explicitly affects the order. `recovery_actions.recovery_plan_id` and `approvals.recovery_plan_id` link the child records to plans.
- Audit activity is included only for audit records whose entity is the order, its verified disruptions or its verified recovery plans.
- Notifications have recipient and role fields but no order foreign key. They are not arbitrarily assigned to orders.

## Backend service

New file: `src/services/order-service.js`.

The service provides database-derived overview metrics, filtered/paginated order listing, order details and related collections. SQL uses parameterized queries. Sort fields and directions are allowlisted. Pagination is limited to 100 records per page.

### APIs

All internal endpoints require an authenticated `HUB_INCHARGE` session:

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/orders/overview` | Order status, active risk, disruption and recovery summary |
| GET | `/api/v1/orders` | Paginated and filtered order register |
| GET | `/api/v1/orders/:id` | Order profile and verified relationship summary |
| GET | `/api/v1/orders/:id/items` | Stored order item lines |
| GET | `/api/v1/orders/:id/shipments` | Shipment records reached through explicit affected-order disruption links |
| GET | `/api/v1/orders/:id/disruptions` | Explicit `disruption_affected_orders` links |
| GET | `/api/v1/orders/:id/risk` | Existing deterministic risk-engine assessment |
| GET | `/api/v1/orders/:id/recovery` | Linked recovery plans, actions and approvals |
| GET | `/api/v1/orders/:id/activities` | Verified audit activity |

Register query parameters: `page`, `limit`, `q`, `status`, `risk`, `disruption` (`yes`/`no`), `warehouse` (warehouse ID), `from`, `to` (`YYYY-MM-DD`), `sort` (`date`, `order`, `customer`, `status`, `deadline`, `items`) and `direction` (`asc`, `desc`).

Invalid pagination, filters, dates and sort options return HTTP 400. Unknown order IDs return HTTP 404. Customers receive HTTP 403 from all internal order APIs.

## Risk calculation

Risk uses `src/domain/risk-engine.js` and its existing `calculateOrderRisk` function and configuration. The service assesses orders only when an active or investigating disruption is explicitly linked to the order. If no such relationship exists, the API returns `available: false`, a null classification and an explanation rather than inventing a risk level.

When multiple active disruptions affect an order, the highest returned deterministic score is shown as the order's current register classification; the risk detail also includes individual disruption assessments. Existing engine evidence and factors are returned unchanged. Workbook illustrative risk scores are not used.

## Frontend

- Register route: `/app/orders`
- Canonical detail route: `/app/orders/:id`
- Navigation label: Network Operations → Customer Orders
- Overview cards and Chart.js status/risk distributions are API-driven.
- Register supports search, status/risk/disruption/warehouse/date filters, sorting, pagination and CSV export.
- Detail view includes customer/order profile, item lines, linked shipments, disruptions, deterministic risk explanation, recovery plans/actions/approvals and verified audit history.
- Linked shipment references open the existing Page 07 shipment detail view.
- Browser back/forward restores the register or canonical order detail.

## Customer privacy boundary

The existing `/api/v1/customer/orders` and `/api/v1/customer/orders/:id` handlers remain unchanged. They continue to scope order queries by the authenticated session's `customer_id`. Internal `/api/v1/orders*` APIs are behind the existing employee-only API boundary and explicit Hub In-Charge checks. Customer UI routes remain blocked from the internal application.

## Known limitations

- No direct order-to-shipment foreign key exists. Shipment links are intentionally limited to verified disruption-affected-order joins.
- No direct product master foreign key exists on order items in this schema; stored SKU and item name are returned as recorded.
- Order risk is unavailable for orders without active disruption links because the existing risk engine requires a disruption context.
- Notification rows have no order relation and are not shown in an order timeline.
- Unit prices are shown only when the stored `unit_price_available` flag permits it.
- No order editing, cancellation, fulfilment mutation or new customer portal was added.
- Synthetic source labels are preserved through `data_origin`.

## Verification

`tests/page10-test.js` covers Hub In-Charge access, Customer HTTP 403, existing customer-owned order access, overview metrics versus SQLite, search and filters, pagination and validation, detail and related collections, shipment de-duplication, deterministic risk engine parity, missing order handling, empty database behaviour and synthetic provenance.

The complete regression suite also runs Pages 01, 04, 05, 06, 07, 08 and 09, including recovery workflow regression. Browser screenshot testing is not claimed.
