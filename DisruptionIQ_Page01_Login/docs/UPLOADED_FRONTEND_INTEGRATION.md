# Uploaded Frontend Integration

## Scope
The supplied `DisruptionIQ_6_0_Login_and_5_Modules` archive was inspected and integrated as the visual reference. Its login experience and full frontend stylesheet are included locally. The reference stylesheet is loaded after the existing application stylesheet on the Hub workspace and Customer Portal so its palette, typography, navigation, cards, chart surfaces, buttons, tables, and form styling are applied to the existing page structure.

## Backend mapping
The supplied archive included its own demo `server.js` and sample `data/demo-data.json`. Those were deliberately NOT copied. The project continues to use the existing Node.js + SQLite backend, authentication/session system, two roles (`HUB_INCHARGE`, `CUSTOMER`), CSRF validation, customer-scoped queries, recovery services, approval gates, and simulated execution controls.

The existing dashboard compatibility view (`GET /api/data`) supplies the reference UI with database-backed overview, shipment, risk, supplier, recovery-plan, approval, and audit collections. Mutations remain on the existing backend routes. Login now redirects according to the authenticated role, and app mutations continue to use the backend's CSRF token.

## Preserved
- Five existing primary navigation destinations and all 26 scroll sections.
- Hub, shipment, supplier, warehouse, inventory, and order modules.
- Disruption Intelligence, risk, scenario simulation, recovery workbench, approvals, execution, audit and Customer Portal.
- Existing server, database schema, domain engines, service modules and API authorization.

## Not copied
The demo backend, in-memory session model, demo credentials, sample-only dataset, and standalone mock operational actions from the uploaded archive were not copied. Doing so would have bypassed the existing SQLite-backed implementation and its security rules.

## Verification
Executed after integration:
- `npm run check`
- `npm test`
- `npm run test:dataset`

All three commands passed. Browser visual automation was not run, so visual rendering should still be checked in Edge/Chrome on the target machine.

## Full-width control-tower hero refinement

The login introduction now uses the supplied full-width cobalt orbit composition as the first viewport. The sign-in form remains available in a dedicated section immediately below the hero, preserving the existing `/api/auth/login` flow, role-based redirects, CSRF/session behavior, and credentials handling. The hero is responsive and respects reduced-motion preferences through the existing stylesheet rules.

## Layout density and typography refinement

The global scroll-section layout no longer reserves a viewport-height minimum for short content. Sections now size to their content with consistent vertical padding, preventing large blank bands between KPI rows and the next dashboard section. Utility labels, table text, form labels, helper copy, recovery workbench metadata and secondary text have been raised to readable minimum sizes while retaining the ABC ROM / IBM Plex Mono hierarchy. Responsive spacing is also tightened on mobile.
