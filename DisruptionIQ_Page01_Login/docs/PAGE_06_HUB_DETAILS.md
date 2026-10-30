# Page 06 – Hub Details

## Scope
Page 06 is an authenticated Hub In-Charge view of one warehouse-backed hub. It reuses the existing `warehouses` table and Page 05 hub aggregation service. No `hubs` table, roles, credentials, coordinates, or operational records are created.

## Routes
- `GET /app/hub-details?id=<warehouse_id>` serves the existing application shell.
- `GET /api/v1/hubs/:id` returns hub identity, Page 05 operational aggregates, metadata, and relationship notes.
- `GET /api/v1/hubs/:id/shipments` returns shipments where the warehouse is origin or destination.
- `GET /api/v1/hubs/:id/disruptions` returns disruptions linked by `disruptions.warehouse_id`, a shipment whose origin/destination is this warehouse, or a source inventory record resolving to this warehouse.
- `GET /api/v1/hubs/:id/inventory` returns inventory rows where `inventories.warehouse_id` matches.
- `GET /api/v1/hubs/:id/orders` returns orders assigned to this warehouse or connected through `disruption_affected_orders` to a hub-linked disruption.
- `GET /api/v1/hubs/:id/recovery` returns associated recovery plan and action rows plus the latest approval state.
- `GET /api/v1/hubs/:id/activities` returns audit records linked to shipments, disruptions, recovery plans, or inventory for this warehouse. The legacy `activities` property remains available alongside `items`.

Collection endpoints accept `page` (default 1), `limit` (default 25, maximum 100), `q` (maximum 100 characters), and `status` (maximum 40 characters). Responses include `items`, `total`, `page`, `limit`, and `total_pages`. Missing warehouse IDs return 404. Invalid pagination returns 400. Internal API and page access is restricted to `HUB_INCHARGE`; `CUSTOMER` receives 403.

## Verified database relationships
- Hub identity is a row in `warehouses` (`id`, `code`, `name`, `location`, `is_active`, capacity fields, `data_origin`).
- Shipments associate to a hub through `origin_warehouse_id` OR `destination_warehouse_id`. Queries use distinct shipment IDs and a single row per shipment.
- Inventory associates through `inventories.warehouse_id`. Available quantity is `MAX(0, quantity - reserved_quantity)`. Low stock is positive available quantity less than or equal to `reorder_point`; out of stock is zero available quantity.
- Disruptions associate through their direct `warehouse_id`, their linked shipment's origin/destination warehouse, or `source_entity_type='INVENTORY'` with a matching inventory `source_record_id` and warehouse. Supplier-only disruptions without one of these relationships are not assigned to this hub.
- Customer orders associate through `assigned_warehouse_id` or `disruption_affected_orders` on a disruption linked to the hub. There is no direct shipment-to-order foreign key in this schema. Shipment-to-order counts therefore use only the verified disruption-affected-order bridge, not SKU similarity. Customer names, email addresses and phone numbers are not returned.
- Recovery plans associate through their disruption. Actions associate through `recovery_actions.recovery_plan_id`; approval status is taken from the latest approval row for the plan. No action records are fabricated.
- Audit events associate through their entity type and entity ID to the above records.

## Risk classification
For orders linked to an active hub-associated disruption, the existing deterministic `calculateOrderRisk` engine is used. The highest calculated score across the order's linked active disruptions is displayed. Orders without an active disruption risk assessment show `null` rather than a fabricated classification.

## Frontend
Page 05 hub register rows open Page 06 using the selected warehouse ID. Page 06 has sections for shipments, disruptions, inventory, affected orders, recovery and activity. Search, status filtering, pagination, refresh, browser back/forward, and return-to-overview navigation are wired to the APIs. Styling additions use the existing CSS tokens and table/card components. The former Page 05 inline detail panel remains in the source but is no longer the row-click destination.

## Limitations
- No direct shipment-to-order relationship exists; the UI reports only verified disruption-based order associations and explicitly documents this.
- Inventory transfer history is not represented by a transfer table and is not displayed.
- Shipment checkpoint/location tracking is not represented by the current schema.
- Some warehouse metadata fields may be null or absent from the source data; the UI shows an unavailable state rather than inventing values.
