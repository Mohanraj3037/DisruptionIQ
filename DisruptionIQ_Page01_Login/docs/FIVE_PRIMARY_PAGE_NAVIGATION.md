# Five Primary Page Navigation

## Purpose

Restructure the Hub Management System into five clear primary destinations while preserving the existing Node.js native HTTP server, SQLite database, vanilla JavaScript frontend, Chart.js integration, APIs, authentication and operational workflows. This is a frontend navigation reorganization, not a backend rebuild.

## Five primary pages and section hierarchy

### 1. Overview (`/app/overview`)
1. Command Center: existing Page 04 heading, status banner, critical KPIs and operational metric tiles.
2. Network Performance: existing hub/network map and network performance component.
3. Disruption Overview: existing priority/disruption signals.
4. Risk & Recovery Overview: existing Page 04 disruption and regional analysis visualizations.
5. Recent Activity: existing operational activity and movement panels.

### 2. Network Operations (`/app/network-operations`)
1. Network Overview: entry cards for the operational workstreams.
2. Hub Management: existing Page 05 Hub Overview and Page 06 Hub Details.
3. Shipment Management: existing Page 07.
4. Supplier Management: existing Page 08.
5. Warehouse & Inventory: existing Page 09.
6. Customer Order Management: existing Page 10.

The existing module DOM, event handlers, API services, search, filters, pagination, exports, tabs and detail panels are retained rather than duplicated. Existing legacy module routes continue to load the same application shell and scroll to the appropriate section.

### 3. Disruption Intelligence (`/app/disruption-intelligence`)
1. Disruption Command Center.
2. Live Disruption Monitoring.
3. Impact Analysis.
4. Risk Prioritization.
5. Scenario Simulation.

The requested baseline is Page 10, which does not contain the dedicated Page 11 disruption-monitoring module. These five sections are explicitly labelled planned-module states. They do not generate incident data, GPS positions, impact counts or scenario results. Existing risk and disruption-related capabilities remain available in their current workflows.

### 4. Recovery Management (`/app/recovery-management`)
1. Recovery Overview: existing recovery KPIs and summary.
2. AI Recovery Recommendations: labelled capability state. Existing recovery options are not represented as a dedicated AI recommendation workspace.
3. Recovery Plans: existing recovery plan board.
4. Approval Center: existing pending approvals UI and approval workflow.
5. Execution Monitoring: existing recovery trajectory and execution-related information.

Existing approval and execution endpoints, permission checks and CSRF controls are unchanged. No automatic approval or execution was added.

### 5. Intelligence & Administration (`/app/intelligence-administration`)
1. Intelligence Overview: existing risk analytics and risk register.
2. Data Management: labelled future UI state; existing import scripts and dataset tooling remain available.
3. Integrations: labelled existing-capability/future-UI state. The baseline includes a carrier webhook simulator and stored webhook events, but no verified external carrier connectivity.
4. Notifications & Communications: notification feed loaded from the existing authenticated notification API, with mark-as-read using the existing endpoint.
5. Audit & Administration: existing audit log and governance information.

## Route structure and compatibility

New primary routes are served by the existing authenticated `/app` handler:

- `/app/overview`
- `/app/network-operations`
- `/app/disruption-intelligence`
- `/app/recovery-management`
- `/app/intelligence-administration`

Legacy routes remain valid for direct links and existing cross-module navigation:

- `/app/hub-overview`
- `/app/hub-details`
- `/app/shipments`
- `/app/suppliers`
- `/app/warehouses`
- `/app/orders`
- `/app/risk`
- `/app/recovery`
- `/app/audit`

All internal application routes remain protected by the existing server-side Hub In-Charge gate. The Customer Portal and customer-owned order API boundary are unchanged.

## Scroll and navigation behaviour

- Sticky top navigation with exactly five primary destinations.
- Natural document scrolling, not a nested scroll container.
- `scroll-snap-type: y proximity` and `scroll-snap-align: start` provide gentle snap alignment without locking long tables into a viewport.
- Sections use a near-full-screen minimum height and can grow to fit their content.
- A fixed right-side section navigator shows the active section and total section count. Its buttons scroll to the selected section.
- Active section tracking updates during scrolling.
- Browser history uses `history.pushState` and `popstate`; legacy module routes remain valid.
- Keyboard scrolling remains native. `Alt+ArrowUp` and `Alt+ArrowDown` move between sections.
- Mobile navigation is horizontally scrollable; section navigation moves to a compact bottom-right position on narrow screens.
- Reduced-motion preferences disable smooth snapping and transitions.

## Backend reuse

No business API, database table, role, or risk engine was added or replaced. Existing dashboard, hub, shipment, supplier, inventory, order, risk, recovery, approval, audit and notification endpoints are reused. Notification read state is persisted through the existing API.

## Files changed

- `public/app.html`: five primary destinations, section wrappers, future-module states, section navigator and notification UI.
- `public/css/styles.css`: sticky top navigation, scroll-snap sections, section indicator, responsive layouts and notification presentation. Existing design tokens are reused.
- `public/js/app.js`: primary/legacy route mapping, section navigation, active section tracking, module loading, notification feed and browser-history handling.
- `server.js`: allowlist for the five new primary routes; legacy routes retained.
- `tests/navigation-test.js`: structural and navigation regression assertions.
- `package.json`: navigation tests included in `npm test`.
- `README.md`, `START_HERE.txt`, `docs/API_CONTRACT.md`: updated usage and route documentation.

## Test results

- Existing authentication, customer ownership, Pages 04–10, recovery workflow and dataset tests passed before implementation.
- After implementation: `npm test`, `npm run check`, and `npm run test:dataset` passed.
- Navigation assertions verify exactly five top-level destinations, all 26 scroll sections, retention of existing module DOM anchors, unique HTML IDs, scroll-snap CSS, sticky navigation, history hooks, new primary routes, legacy routes, and explicit future-module labels.
- 28 JavaScript files passed syntax checks.
- 17 synthetic dataset sheets × 350 rows passed the existing idempotency and provenance test.
- Browser screenshot/responsive visual verification was not performed in this environment.

## Known limitations

- Page 11 is not included in the specified Page 10 baseline. Disruption Intelligence therefore contains planned-module placeholders rather than a fabricated monitoring interface.
- Data Management and dedicated Integration health interfaces are not implemented in the baseline and are clearly marked accordingly.
- The existing AI recovery recommendation capability is not a dedicated AI recommendation workspace; its section is labelled accordingly.
- Scroll snapping uses proximity by design so content-heavy sections remain usable and scrolling is not hijacked.
