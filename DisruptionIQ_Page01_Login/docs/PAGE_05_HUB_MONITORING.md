# Page 05: Hub Overview & Monitoring

## Scope

Page 05 is a `HUB_INCHARGE`-only monitoring view. It reuses the existing Node.js native HTTP server, SQLite database, session authentication, vanilla JavaScript frontend and existing CSS design tokens. It does not create a new Hub Details page, a new user role, a second database, or a new hub entity.

## Repository inspection

| Area | Existing state | Page 05 handling |
|---|---|---|
| Hub entity | No `hubs` table exists | `warehouses` are the hub records |
| Hub identity | `warehouses.id`, `code`, `name`, `location` | Returned as hub ID/code/name/location |
| Operational status | `warehouses.is_active` | Active/Inactive; no inferred status |
| Shipment relationships | `shipments.origin_warehouse_id`, `destination_warehouse_id` | Distinct shipment count per warehouse if either endpoint references it |
| Direct disruption relationship | `disruptions.warehouse_id` | Used directly |
| Shipment disruption relationship | `disruptions.shipment_id` | Hub inferred only through the linked shipment's origin/destination warehouse |
| Inventory disruption relationship | `disruptions.source_entity_type/source_entity_id` plus `inventories.source_record_id/warehouse_id` | Used only when source type is `INVENTORY` and the source record resolves |
| Order impact | `disruption_affected_orders` | Distinct linked order IDs, no customer names exposed |
| Recovery | `recovery_plans`, `recovery_actions`, `approvals` | Plans follow their disruption's supported warehouse/shipment/inventory relationship |
| Activity | `audit_logs` | Shipment, disruption and recovery-plan events filtered through the linked entity IDs |
| Transfer tracking | No transfer entity/table found | Not displayed or fabricated |
| Geography | Warehouse `location` text only | No coordinates, routes or map pins generated |

The workbook contains supplier-sourced disruptions without a warehouse, shipment or inventory relationship. Those records remain unassigned and are excluded from hub-level aggregates. Inventory-sourced disruptions are associated only through the imported inventory source identifier and its actual warehouse foreign key.

## API contract

All endpoints require an authenticated `HUB_INCHARGE` session. The existing `/api/` authorization gate returns `401` without a session and `403` to `CUSTOMER` sessions.

### `GET /api/v1/hubs/overview`

Returns network summary, hub health distribution and `last_updated`.

`summary` fields:
- `total_hubs`, `active_hubs`
- `total_shipments`, `delayed_shipments`
- `active_disruptions`, `affected_customer_orders`
- `inventory_tracked_items`, `available_stock_units`
- `low_stock_products`, `out_of_stock_products`, `stock_shortage_orders`
- `recovery_actions_in_progress`

Hub-level summary shipment counts include only shipments linked to at least one warehouse. A shipment with both origin and destination warehouses is counted once in the network total and once in each relevant hub's own count.

### `GET /api/v1/hubs`

Query parameters:
- `page`: positive integer, default `1`
- `limit`: integer `1..100`, default `25`
- `q`: case-insensitive search across hub ID, code, name and recorded location (maximum 100 characters)
- `status`: `active` or `inactive`
- `health`: `healthy`, `watch` or `critical`
- `disruption`: `active` or `none`

Returns `total`, `page`, `limit`, `total_pages`, and `hubs[]`. Invalid pagination or filter values return `400`.

Each hub record includes the warehouse identity/status and nested `shipment`, `disruptions`, `inventory`, and `recovery` aggregates. No customer personal data is included.

### `GET /api/v1/hubs/:id`

Returns the warehouse-backed hub record plus up to 100 linked shipment, inventory, affected-order, active-disruption and recovery-plan records. Customer names, emails and phone numbers are not returned.

### `GET /api/v1/hubs/:id/activities?limit=20`

Returns up to 100 recent audit events whose shipment, disruption or recovery-plan entity is linked to the selected warehouse. A warehouse with no linked audit events returns an empty array, not fabricated activity.

## Calculation rules

### Shipment aggregation

A shipment belongs to a hub's shipment count when its `origin_warehouse_id` **or** `destination_warehouse_id` equals that warehouse. Each shipment ID is counted once per hub. `in_transit`, `delivered`, and `delayed` use the stored shipment status. `disrupted` requires an active/investigating disruption linked directly to that shipment. A warehouse-level disruption is not automatically assigned to every shipment in the warehouse. `at_risk` uses the stored `ui_status` value `At Risk` and excludes shipments already counted as disrupted.

### Inventory

Available quantity is `MAX(0, quantity - reserved_quantity)`. A low-stock SKU has available quantity greater than zero and less than or equal to `reorder_point`. An out-of-stock SKU has zero available quantity. An order is a stock-shortage order when it has an assigned warehouse and at least one order line has no matching warehouse/SKU inventory row or its available quantity is below that line's requested quantity. Orders without an assigned warehouse are not treated as hub shortages.

### Recovery

Recovery plans are attached to a hub only through a direct warehouse disruption, a disruption linked to a shipment whose origin/destination references the warehouse, or an inventory-sourced disruption whose source inventory row belongs to that warehouse. Pending approvals are based on pending approval records and/or a plan in `Pending Approval`. Approved plans use the existing `Approved`, `Execution Ready`, and `Executing` states. Action states are counted from `recovery_actions`: `In Progress`/`Executing`, `Completed`, and `Blocked`/`Failed`.

### Deterministic health status

No numeric health score or AI output is used.

- **Critical** if any product is out of stock; or the hub has at least one delayed shipment and at least one active disruption; or at least 25% of its linked shipments are delayed; or it has at least three active disruptions.
- **Watch** if not Critical and at least one of these is true: delayed shipment, active disruption, low-stock product, or recovery action in progress/blocked/failed.
- **Healthy** otherwise.

Inactive warehouse status is shown separately and does not overwrite the calculated health label.

## Frontend integration

The Page 04 overview and its existing dashboard data path remain intact. One `Hub Monitoring` navigation entry and a matching page view were added because the inspected Page 04 archive did not contain a separate hub-monitoring screen. The existing navigation component, typography, colors, spacing, responsive breakpoints and card/table styling are retained. The new view uses the same `sub-kpi`, `chart-card`, `table-card`, `data-table`, and theme tokens.

The view supports summary refresh, search, operational-status filter, health filter, active-disruption filter, server pagination, and inline selected-hub record inspection. Shipment/disruption counts open the selected hub's linked record panel rather than navigating to an unimplemented detail page.

## Synthetic data

The existing one-time expanded-dataset importer remains unchanged and is not invoked by Page 05. Page 05 reads the existing SQLite rows and preserves `data_origin`, source identifiers and foreign keys. It does not re-import the workbook, invent recovery actions, attach supplier-only disruptions to a warehouse, or generate geographic information.

## Known limitations

- A separate Hub master entity does not exist; warehouse identity is the hub identity.
- There is no inventory-transfer table or transfer event contract, so inventory transfers cannot be monitored.
- Warehouse location is free-text and does not provide validated latitude/longitude.
- Shipment activity can be grouped by origin and destination warehouse; the data model does not identify a current physical checkpoint beyond those endpoint relationships.
- Recent activity is limited to audit events for shipment, disruption and recovery-plan entities linked to the hub. Webhook and notification records are not attributed to a hub unless an explicit audit/entity relationship is available.
- Health labels are operational heuristics documented above, not predictive or AI-generated scores.
- The inline record panel is a Page 05 monitoring interaction, not a separate Hub Details page.
