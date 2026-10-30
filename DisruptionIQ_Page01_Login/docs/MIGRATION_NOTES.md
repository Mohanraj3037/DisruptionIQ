# Python → JavaScript migration notes

## Source inventory

The uploaded Python source contains Flask routes, SQLAlchemy model definitions, authentication, deterministic risk scoring, disruption detection, impact analysis, recovery planning/execution, audit, notifications, imports, webhooks and optional LLM provider integrations. The supplied frontend archive is kept as the frontend frame; no Python templates or Python frontend are imported.

The ZIP does not contain an SQLite database file, saved `.pkl`/`.joblib`/`.onnx`/`.h5`/`.keras`/`.pt`/`.pth` weights, or a training pipeline. Therefore this migration does not claim to convert a trained model. Any separate trained artifacts must be supplied and evaluated independently.

## Deliberate implementation choices

- Node.js native HTTP avoids introducing a new framework dependency and keeps the project runnable without network package installation.
- Node's built-in `node:sqlite` provides local SQLite persistence. It is marked experimental in Node 22; use the specified Node LTS runtime and back up the database regularly.
- The application keeps the supplied DisruptionIQ 6.0 frontend frame and exposes the API shape expected by its JavaScript. Exactly five application modules are exposed, plus login.
- Python model table names and core columns are mirrored. Additional UI fields are additive columns in the Node schema.

## Risk scoring

Ported weighted formula:

- deadline risk: 0.35
- shortage risk: 0.30
- customer priority: 0.20
- recovery difficulty: 0.15

Severity thresholds:

- Critical: >=80
- High: >=60
- Medium: >=30
- Low: <30

The engine remains read-only and calculates dynamically from database records. It preserves missing deadline handling, overdue handling, delay buffer bands, reserved-stock exclusion, shared demand, customer tier modifiers, supplier lead time and score tie-breaking.

## Recovery ranking discrepancy

The Python recovery planning file contains a prose/comment formula that differs from its executable formula. The Node implementation preserves the executable weights: 0.35 risk reduction + 0.30 delay reduction + 0.20 cost score + 0.15 feasibility. This should be confirmed by comparing representative Python-generated recommendation outputs before production cutover.

## Password handling

New demo accounts use Node scrypt hashes. The verifier supports Werkzeug scrypt and PBKDF2 formats so compatible legacy hashes can authenticate without recovering plaintext passwords. Successful legacy logins are upgraded to the Node hash format.

## Database import

`scripts/import-sqlite.js` creates a separate target database and copies matching columns from the known SQLAlchemy table names, including the `disruption_affected_orders` association table. It preserves ids and relationship ids where schemas match and reports foreign-key violations. It must be run against a copy of the Python database, never the only copy. The backend ZIP did not include the user's live `instance/disruptioniq.db`, so final parity on that database must be confirmed after import.

## Parity checklist before retiring Python

1. Export test records from Python and save expected component scores.
2. Compare deadline, shortage, priority and recovery-difficulty component outputs.
3. Compare final risk score, severity and rank order.
4. Compare disruption detection and affected-order sets.
5. Compare recovery candidate options and ranking.
6. Validate role permissions, approval separation-of-duties and version invalidation.
7. Validate import results, webhook idempotency and audit history.
8. Run both systems against separate copies of the same database snapshot.
9. Switch the frontend only after all parity tests pass.
