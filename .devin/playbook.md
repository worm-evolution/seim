# SEIM — Devin Playbook (v1.0.4)

## Project Summary
SEIM is an autonomous, full-stack self-evolving infrastructure middleware for Node.js (Express, Fastify) and React.

## Environment & Build Setup
- **Node.js**: Requires Node.js 18+
- **Build**: `npm run build`
- **Unit & Integration Tests**: `npx jest --no-coverage --runInBand` (28 test suites, 153 tests)
- **Benchmark Suite**: `npm run test:benchmark`

## Key Workflows
1. **Telemetry & Issue Stream**:
   - `src/behaviorTracker.ts`: Ingests real visitor journey telemetry.
   - `src/issueStream.ts`: Discovers missing APIs, 5xx bugs, and UX loops with Sybil-resistant filtering.
2. **Scaffolding & PR Engine**:
   - `src/prGenerator.ts`: Generates staging branches and `.patch` files.
   - `src/scaffolder.ts` & `src/frontendEvolver.ts`: Generates Express route handlers and React TSX components into `src/seim-generated/`.
3. **Execution & Routing**:
   - `src/dynamicRouter.ts`: Hot-swaps and routes dynamic handlers with parameter matching.
   - `src/sandbox.ts`: Safely executes code with `vm` or `isolated-vm`.
4. **Studio Dashboard**:
   - `src/studio.ts`: Neo-Brutalist dashboard (Dark/Light mode, maroon theme `#800020`, zero emojis).
