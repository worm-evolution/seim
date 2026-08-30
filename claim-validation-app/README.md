# SEIM claim-validation app

This is a deliberately small but real baseline web application: React/Vite on the frontend, Express on the backend, and `seim-core` installed from the current package archive in `vendor/current/`.

Run the acceptance flow from this directory:

```bash
npm install
node node_modules/seim-core/dist/cli/index.js handoff . --force
node node_modules/seim-core/dist/cli/index.js delivery . --vercel --aws --force
npm test
```

The automated check covers baseline route preservation, built React instrumentation, runtime observation, Studio authentication and headers, metrics, browser telemetry, dashboard behavior, safe React fallback generation, frontend/backend handoff detection, and generated Vercel/AWS delivery safeguards. Live GitHub, Vercel, AWS, Redis, Postgres, and external AI checks require separate provider credentials and infrastructure.

See [CLAIM_RESULTS.md](./CLAIM_RESULTS.md) for the latest result matrix and the exact boundary between locally verified behavior and provider acceptance tests.
