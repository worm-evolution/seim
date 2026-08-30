# SEIM Package-Wide Audit

**Review date:** 2026-08-30  
**Scope:** `seim-core` package, source, generated dashboard, adapters, demo, tests, package metadata, and operational documentation.

## Executive summary

SEIM has a credible foundation for a controlled self-evolving application platform: the build is healthy, the unit/integration test suite is passing, production sandboxing and authentication have received substantial hardening, and the engineer workflow is bounded rather than an unrestricted code executor.

It is not yet production-ready as an autonomous software team. The largest gaps are operational and product-level: the dashboard presents stale or unsafe-looking actions, the runtime has several divergent evolution paths, state and events are not consistently designed for multi-instance operation, generated React code accepts insufficiently constrained input, and there are no browser/accessibility or live-provider contract tests. The package should be treated as a controlled pilot until these are addressed.

**Assessment:** 6.5/10 for a controlled pilot; 4.5/10 for unattended general production use.

## Verification performed

| Check | Result | Evidence / implication |
|---|---|---|
| TypeScript build | Pass | Current source compiles. |
| Jest suite | Pass | 43 suites, 221 tests passed after adding regression coverage. |
| Production dependency audit | Pass | `npm audit --omit=dev` reported 0 vulnerabilities. |
| Package archive | Pass | `npm pack --dry-run`: 468 files, about 1.5 MB unpacked. |
| Demo flow runner | Concern | Connection to `127.0.0.1:3005` failed; the runner still exited successfully because the error is printed rather than propagated. |
| Source maintainability scan | Concern | Approximately 17k source LOC, 299 `any` occurrences, and 112 `console` occurrences. |

## Findings by aspect

### 1. Architecture and design principles

- The package has useful separation between telemetry, evolution, verification, React generation, adapters, and the engineer control plane.
- `src/studio.ts` is about 1,000 lines and owns HTTP routing, HTML/CSS/JS rendering, state presentation, polling, and mutations. This violates single responsibility and makes UX, security, and API changes difficult to reason about.
- The package exposes a broad internal surface from `src/index.ts`; a deliberate public API boundary and `exports` map are missing.
- The global Studio event ring buffer is process-global. Multiple SEIM instances in one process can observe each other’s events, which is a tenancy/isolation and testability problem.
- There are several overlapping evolution workflows (runtime candidates, legacy PR generation, engineer control plane, and CI repair). Their state machines, promotion rules, and ownership are not unified.
- The high `any` count weakens the type boundaries that are especially important for generated code, provider responses, persistence, and mutation requests.

**Priority:** P1. Split Studio into route/controller, view/template, and client assets; define domain ports and an explicit public API; make event history instance-scoped and externally persisted where required.

### 2. Correctness and integration

- The README Express example mounts `s.listener()` before `express.json()`, while telemetry handling needs a parsed body. The demo uses the safer order; the copy-paste documentation does not.
- The demo runner assumes a separately running server and catches errors without setting a failing exit code. CI can therefore report success when the demo is unavailable.
- Express supports live handler replacement, while Fastify and generic HTTP have more limited behavior. This is documented in places, but the capability matrix and runtime contract should be explicit.
- Several operations are asynchronous/fire-and-forget from the dashboard perspective. Without an operation ID and durable status, users cannot reliably distinguish accepted, running, failed, and completed work.
- The code is bounded by supported task kinds and verification stages; it does not yet cover arbitrary application changes a real software team would handle.

**Priority:** P1. Fix the README example and demo exit behavior; standardize adapter capabilities and operation lifecycle responses.

### 3. Self-evolution goal

SEIM can take over selected maintenance tasks after a baseline exists, but it is not yet a complete “one-time development, then autonomous team” system. It currently needs explicit task classification, supported workflows, verification, provider configuration, and human review for sensitive/unsupported work. That bounded model is the correct safety posture, but the product should state the boundary plainly.

- The dashboard still displays a “1-CLICK MERGE & DEPLOY” action even though the legacy endpoint intentionally returns `410`. This is a direct product contradiction and can mislead operators.
- Autonomous promotion needs explicit blast-radius policy: protected branches, approval gates, rollback criteria, deployment budgets, and per-project permissions.
- React structural problems are warned about in generation paths rather than consistently blocking promotion.
- “Learned” behavior and candidate promotion need durable provenance: source event, model/config version, diff, tests, approval, deployment, and rollback link.

**Priority:** P0 for the stale merge action; P1 for unified state machine and promotion policy.

### 4. Dashboard usability and UI

- The dashboard combines eight dense tabs (shipped, PRs, issues, telemetry, candidates, behavior, events, raw state) with high information density and limited task-oriented guidance.
- Actions rely heavily on `alert()` and `confirm()`. There are no consistent loading states, disabled states, inline validation, retry controls, or operation progress views.
- A refresh performs many polling requests and rebuilds sections using `innerHTML`. This creates unnecessary network/render work and makes incremental updates and error isolation harder.
- There is no visible pagination, filtering, search, or time-window control for event/candidate/telemetry views.
- Empty states are generic; users are not consistently told whether data is absent, a worker is disabled, a provider is unconfigured, or a request failed.
- Data escaping is present in many display paths, which is good, but inline event code and a large server-rendered template remain fragile.

**Priority:** P1. Replace the dashboard with task-focused views and a small client state layer; introduce operation status, toast/inline errors, filters, pagination, and explicit system-state empty states.

### 5. Accessibility, responsive behavior, and interaction quality

- Tabs are visually implemented but lack robust `tablist`/`tab`/`tabpanel` semantics and complete keyboard navigation.
- Modal behavior does not provide a complete focus trap, Escape handling, focus restoration, and screen-reader labeling contract.
- `switchTab` relies on the browser-global `event` rather than receiving an event or tab ID explicitly, which is brittle and can fail outside the expected inline-handler context.
- No browser, accessibility, responsive, or visual regression tests were found. CSS overflow rules alone do not establish usable mobile behavior.

**Priority:** P1. Use semantic controls and delegated handlers, then add Playwright-style smoke/a11y coverage for the critical dashboard journeys.

### 6. React/frontend generation quality

- The generated fallback component interpolates the user intent into TSX source. Quotes, template delimiters, or hostile input can produce invalid code or alter generated source. Intent must be passed as data or safely encoded, followed by syntax/type validation.
- The component checker flags `dangerouslySetInnerHTML`, `eval`, and `document.write`, but warning/error policy should be tied directly to promotion gates.
- Generated API helpers now perform endpoint validation/serialization, which is a positive hardening step; the remaining generated-code surface needs the same strict contract.
- A giant template string is difficult to test and evolve. Prefer an AST/codegen layer or small templates with golden tests.

**Priority:** P0/P1. Remove raw intent interpolation, validate generated source with a parser/compiler, and make unsafe findings promotion-blocking by policy.

### 7. Reliability, scalability, and lifecycle

- Redis-backed state is not the sole source for every metric, candidate, learned-pattern, artifact, and changelog path. Multi-replica decisions can diverge unless ownership and consistency guarantees are explicit.
- The in-memory event buffer is unsuitable for cross-replica history and can lose events on restart.
- There is no clear readiness contract that checks storage, worker, GitHub, Vercel/AWS, and sandbox dependencies separately.
- Shell execution and external isolation are powerful operational boundaries, but timeout, cancellation, workspace cleanup, quotas, and retry/idempotency policies need to be first-class and observable.
- No live-provider or multi-replica drills were identified; unit/mocked tests cannot prove deployment, webhook, failover, or recovery behavior.

**Priority:** P1. Define durable state ownership, readiness checks, idempotency keys, cancellation/cleanup, quotas, and failure-injection tests.

### 8. Security and privacy posture

The recent hardening is materially positive: production authentication cannot be disabled by configuration, JS config loading is opt-in, symlink verification is rejected, same-origin checks protect Studio mutations, schema identifiers are validated, errors are generic with request IDs, event/code redaction is present, and production sandboxing requires `isolated-vm`.

Remaining audit concerns are primarily systemic: generated-code input constraints, broad provider permissions, dashboard exposure of operational data, missing durable audit trails, and the need to verify secret handling across every new adapter/provider. `cors()` in the demo is unrestricted and should not be copied into production.

**Priority:** P1. Add a threat model per provider/action, least-privilege deployment credentials, durable audit records, redaction tests, and an allowlist-based CORS example.

### 9. Observability and operations

- There is no consistently propagated correlation ID spanning telemetry, job, verification, GitHub, deployment, and feedback.
- Logs use many direct `console` calls rather than one structured logger with severity, redaction, and stable fields.
- Health, readiness, queue depth, evolution latency, verification failure rate, rollback rate, and provider error rate need standard metrics and alert thresholds.
- Operators need a runbook for stuck jobs, failed verification, provider outage, rollback, credential rotation, and data recovery.

**Priority:** P1. Establish structured observability and an operator-facing incident model before unattended operation.

### 10. Developer experience and API design

- Package identity is inconsistent: the package is `seim-core`, examples use local `dist/index`, while the generated starter uses `require('seim')`. Generated projects should use the published package name or a documented alias.
- README verification numbers are stale relative to the current 43-suite/216-test result.
- There are scripts for build/test/stress/benchmark, but no lint, format, typecheck-only, coverage threshold, API compatibility, or browser test scripts.
- The JS configuration opt-in is safer, but the configuration matrix and production behavior need prominent documentation.
- `generateComponent` and several integration boundaries should have strict request/response types instead of broad structural objects.

**Priority:** P1. Align package names and examples, refresh docs from CI, add lint/format/coverage/API checks, and reduce `any` at boundary modules.

### 11. Testing and release readiness

The unit foundation is strong: the current suite passes and includes security hardening coverage. The missing confidence layers are browser/a11y tests, generated-code golden/type tests, live adapter contract tests, provider sandbox tests, failure-injection/recovery tests, and multi-instance consistency tests.

The package archive is installable and reasonably sized, but release hygiene would benefit from an `exports` map, provenance/version checks, a documented optional `isolated-vm` installation requirement, and CI that tests the packed artifact rather than only the workspace.

**Priority:** P1. Add the missing test layers and make packed-artifact verification a release gate.

### 12. Documentation and product contract

Architecture documentation is substantially useful, but the product contract is fragmented across README, architecture notes, and implementation comments. The supported automation boundary, state transitions, adapter capability differences, required credentials, approval model, and rollback behavior should be one operator/developer guide.

The phrase “real-time visitor activity will trigger evolution” can overpromise when the relevant worker/provider is disabled or not configured. Documentation should distinguish installed capability from enabled, healthy capability.

## Prioritized action plan

### P0 — resolve before autonomous promotion

1. Remove or relabel the dashboard’s disabled merge/deploy action.
2. Eliminate raw user-intent interpolation in generated TSX and make generated-source validation a hard promotion gate.
3. Ensure every autonomous mutation has authorization, durable audit data, an operation ID, and rollback/approval policy.

### P1 — resolve before production pilot

1. Split the Studio server/view/client responsibilities.
2. Unify evolution workflows behind one durable state machine and explicit provider/adapter capability model.
3. Make events and state multi-instance safe; add readiness checks and correlation IDs.
4. Add browser/a11y/responsive tests, generated-code tests, live adapter contracts, and failure-injection tests.
5. Fix README/demo/package-name drift and add lint, formatting, coverage, API, and packed-artifact CI gates.
6. Add dashboard filtering, pagination, progressive loading, inline errors, and honest empty states.

### P2 — scale and polish

1. Reduce `any` and direct console logging at boundaries.
2. Add visual regression and performance budgets for the dashboard.
3. Add operator runbooks, SLOs, cost budgets, and automated dependency/version reporting.

## Conclusion

SEIM is a promising controlled automation framework, not yet a drop-in autonomous engineering team. Its goal is achievable in a constrained form if the baseline app is treated as a governed product: SEIM must own a durable change lifecycle, understand the repository, make bounded changes, verify them, obtain policy-approved promotion, deploy through least-privilege providers, observe outcomes, and roll back safely. The P0/P1 items above are the shortest path from the current package to that operating model.

## Implementation update after audit

The following audited issues were fixed in this pass:

- Removed the misleading dashboard “1-click merge & deploy” action; open PRs now direct operators to review in GitHub.
- Added semantic tab and panel roles, explicit tab selection state, and removed the dashboard’s dependence on the browser-global `event` object.
- Added dialog semantics to the code-inspection modal.
- Validated React component identifiers before generation, kept intent text as serialized data in fallback TSX, and made failed structural validation block registration.
- Corrected the README Express middleware order and refreshed verification counts.
- Corrected generated CLI examples and starter dependencies from `seim` to the published `seim-core` package name.
- Restricted the demo CORS example to an explicit origin and made the demo flow return a failing process status when the server is unavailable.

The remaining P1/P2 items in this document—durable operation tracking, full dashboard state management, multi-replica event/state consistency, structured observability, provider drills, and browser/a11y test infrastructure—require a larger product/operations phase and are not silently presented as complete.
