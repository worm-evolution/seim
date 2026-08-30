# SEIM — Claude Code Assistant Guidelines (v1.0.4)

## Architecture Overview
SEIM is an autonomous full-stack self-evolving infrastructure middleware for Node.js (Express, Fastify, Generic HTTP) and React applications.

### Key Workflows
1. **Request Interception**: `s.listener()` records non-blocking metrics via `BehaviorTracker` and checks `dynamicRouter.hasHandler(routeKey)` to execute dynamically evolved routes before delegating to `next()`.
2. **Issue Triage**: `IssueStream.scanAndEmit()` evaluates 404 frequencies across multiple sessions (Sybil resistance), 5xx error spikes, and UX drop-offs.
3. **Autonomous Scaffolding & PRs**:
   - In `bypass` mode: `EvolutionOrchestrator` generates backend handlers (`FeatureScaffolder`) and React TSX components (`FrontendEvolver`) and registers routes in `DynamicRouter`.
   - In founder PR mode: `PrGenerator` creates named staging branches, unified `.patch` files, and PR documentation for 1-click merge approvals.
4. **Neo-Brutalist Studio Control Center**: Accessible at `/seim`, with Dark/Light mode, rich Maroon (`#800020`) brand accents, zero emojis, and code diff viewers.

## Commands for Claude
- **Build**: `npm run build`
- **Run all tests**: `npx jest --no-coverage --runInBand` (current baseline: 42 suites, 206 tests)
- **Run benchmarks**: `npm run test:benchmark`
- **Run stress tests**: `npm run test:stress`

## Key Implementation Rules
- Always preserve non-blocking performance: Request interceptor overhead must remain under 0.010ms.
- Timers in background workers must use `.unref()` to avoid keeping Node.js processes alive during testing or shutdown.
- Pre-flight security: Never allow generated code to modify auth, payment, or process secrets.
