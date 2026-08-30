# SEIM — Codex & Cursor Agent Rules (v1.0.4)

You are working on SEIM, an autonomous self-evolving infrastructure middleware for Node.js and React.

## Core Rules & Invariants
1. **Zero Downtime Routing**: Dynamic routes registered in `DynamicRouter` must resolve seamlessly via `DynamicRouter.getHandler()` with support for parameterized paths (`:id`).
2. **Strict Sybil Resistance**: `IssueStream` must strictly enforce multi-session consensus (`affectedSessions >= minSessions`) before flagging any 404 as a missing feature.
3. **Sandbox Safety**: `Sandbox.runVm` and `Sandbox.runIsolated` must safely execute handlers even if defined as full `async function handler(req, res)` declarations or raw statements.
4. **Neo-Brutalist UI**: The Studio Control Center at `/seim` strictly uses zero emojis, monospaced status badges (`[SHIPPED]`, `[PULL REQUESTS]`, `[ISSUES]`, `[LIVE]`), tactile drop-shadows, and a Maroon (`#800020`) brand accent in light mode.
5. **Testing Verification**: Always verify changes by running `npm run build && npx jest --no-coverage --runInBand` (current baseline: 42 test suites, 206 tests).
