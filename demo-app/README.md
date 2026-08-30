# SEIM developer playground

This Express playground demonstrates local SEIM runtime behavior: traffic generation, latency injection, issue discovery, candidate inspection, dynamic route evolution, telemetry, changelog entries, and rollback controls.

It is a local demonstration, not a GitHub/Vercel/AWS production environment. Repository handoff and cloud delivery are configured from the target application repository with the main SEIM CLI.

## Run

```bash
cd demo-app
npm install
npm start
```

Optional AI-backed generation can use a configured provider key. Without one, supported template/fallback behavior remains available.

Open:

- Playground: <http://localhost:3005>
- SEIM Studio: <http://localhost:3005/seim>

## Demonstrated flow

1. Generate requests against the sample API.
2. Inject the sample latency bottleneck or repeated missing-route traffic.
3. Inspect metrics and issues in Studio.
4. Trigger or wait for the configured evolution path.
5. Inspect generated candidates, dynamic routes, and changelog entries.
6. Exercise rollback where the demo exposes it.

## Automated demo check

With the demo server running:

```bash
node test_demo_flow.js
```

For the package-wide verified suite, run `npm test -- --runInBand` from the repository root. The architecture and production boundaries are in [architecture.md](../architecture.md).
