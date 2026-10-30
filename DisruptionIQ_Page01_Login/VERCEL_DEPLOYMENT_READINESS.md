# Vercel deployment readiness

## Current status: not production-ready for Vercel

This project currently starts a long-lived Node HTTP server (`server.js`) and stores mutable application state in a local SQLite file (`instance/disruptioniq.db`). It uses Node's built-in `node:sqlite` API.

Vercel's Node.js server support does not make a local SQLite file a shared, durable database. Vercel documents function filesystems as read-only apart from temporary `/tmp` storage, and its SQLite guidance explains that independent function instances cannot share one durable local database. That would make sessions, plan approvals, audit rows, scans, notifications and shipment updates unreliable or temporary.

Before a production Vercel deployment, the app needs: 
1. A Vercel-compatible Node server entrypoint or supported framework adapter.
2. Migration from local SQLite to a hosted persistent database (for example Postgres via Neon or Supabase, or a hosted libSQL/Turso database).
3. Replacement of synchronous SQLite query helpers with a suitable async database layer, including transaction and migration handling.
4. Production session storage, secrets, CORS/CSRF and cookie-domain configuration.
5. A deployment smoke test covering login, database reads/writes, maker-checker approval and audit persistence across separate requests/instances.

Do not deploy this build as a production Vercel app with the local SQLite database. Local deployment on a persistent Node host or the user's Mac remains suitable for the current project build.
