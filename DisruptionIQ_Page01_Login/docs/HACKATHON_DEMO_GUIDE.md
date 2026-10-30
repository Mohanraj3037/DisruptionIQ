# DisruptionIQ – Hackathon Demo Guide

## 1. Start the application

Requirements: Node.js 22.13 or newer.

1. Extract the ZIP.
2. Open CMD in `DisruptionIQ_Page01_Login`.
3. Run `npm start`.
4. Open the Login URL printed in CMD.

The default SQLite database is created in `instance/disruptioniq.db`. For a fresh demo database, import the expanded synthetic dataset once with `npm run import:expanded-dataset`. Do not run it repeatedly against a production database.

## 2. Demo accounts

| Role | Email | Password |
|---|---|---|
| Hub In-Charge | `hub@disruptioniq.local` | `Hub@DIQ2026!` |
| Customer | `customer@disruptioniq.local` | `Customer@DIQ2026!` |

The development customer is linked to seeded synthetic orders. Never use these development credentials in production.

## 3. Maker-checker approval

1. Sign in as Hub In-Charge (`hub@disruptioniq.local`) to create and submit a recovery plan.
2. Sign in separately as Recovery Manager (`recovery@disruptioniq.local`) to approve, reject or request changes.
3. The maker cannot approve their own plan. Risk Analyst may inspect and simulate risks but cannot approve or execute recovery plans.
4. The Recovery Manager may execute an approved plan after reviewing and confirming the simulated execution.

All approval and execution events are written to the append-only audit log. Imported synthetic workbook events are archived as reference fixtures, not treated as real approvals.

## 4. Demo A – Disruption to customer update

1. Sign in as `hub@disruptioniq.local`.
2. Open **Disruption Intelligence**.
3. Select a recorded disruption in the register and inspect its impact. If needed, use the scenario simulator to explore a hypothetical road accident or severe weather case. Simulation is read-only and does not create a real disruption.
4. Open **Recovery Management**.
5. In **Recovery recommendation workbench**, select the same disruption and generate recommendations.
6. Review the verified order and inventory context, recommendation coverage, constraints and unknowns. A transfer option remains constrained until a human verifies logistics.
7. Select an option and create a draft plan. Leave cost blank if no verified estimate exists.
8. In **Recovery Plans**, submit the draft for approval.
9. In the second browser profile, sign in as the independent Recovery Manager. Review the plan and approve it, or request changes/reject with comments.
10. Return to the requester session. In **Execution Monitoring**, open **Review & execute**. Review linked shipment, affected orders, inventory, known/unknown cost and customer impact. Confirm explicitly.
11. For a supported inter-warehouse transfer, the application rechecks inventory and the source reorder point, writes a simulated stock movement, and logs the result. No physical delivery is claimed.
12. Open **Disruption Intelligence**, inspect the same incident, choose an approved/executed recovery plan in the customer update form, write a verified message, and tick the disclosure confirmation.
13. Sign in as the linked customer and open the order. Confirm the approved recovery summary and notification appear in the Customer Portal.
14. Return to Hub **Intelligence & Administration** to inspect audit, import and webhook history.

## 5. Demo B – Webhook reliability

1. Open **Intelligence & Administration → Integrations**.
2. Select a shipment and choose a simulated event such as Shipment delayed, Vehicle accident, Shipment arrived or Shipment delivered.
3. Process the event and inspect webhook history.
4. Reuse the same event ID through the API to demonstrate idempotency; the simulator UI generates IDs automatically.
5. Try an invalid event timestamp through the API to see a Failed event with error details.

## 6. Demo C – Import safety

1. Open **Intelligence & Administration → Data Management**.
2. Choose suppliers or warehouses for insert-only imports, or shipments/inventory for existing supported schemas.
3. Upload a CSV/JSON file and run validation preview.
4. Commit only after checking rejected rows and the preview.
5. Existing supplier/warehouse codes are rejected. Existing shipment/inventory records are rejected unless the explicit update checkbox is enabled and a second commit confirmation is accepted.

## 7. Test commands

```cmd
npm run check
npm test
npm run test:dataset
```

## 8. Important demonstration wording

Use **simulated recovery execution** when describing the database update. Do not claim that stock physically moved, a carrier was booked, an order was delivered or an external supplier accepted an order. The project records a controlled, human-confirmed simulation with a traceable audit trail.
