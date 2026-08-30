# SEIM product readiness status

**Package:** `seim-core` 1.0.4

**Review date:** 2026-08-29

**Status:** working, tested foundation; controlled production pilot readiness, not arbitrary unattended-development readiness

## Verified evidence

The current repository was reviewed against its source rather than the previous product claims. The following checks pass after the persistence repair:

```text
npm run build
npm test -- --runInBand
npm pack --dry-run --json
```

Results:

- TypeScript build passed.
- 42 Jest suites passed.
- 216 tests passed.
- Package dry run passed.
- Endpoint versions, exact transitions, active state, rollback safety, deprecation, restart loading, and single-version rollback behavior have focused regression coverage.

No live external account was exercised in this review. Redis, Postgres, GitHub, Vercel, and AWS behavior is covered by component tests and generated-workflow tests, not by a live production drill.

## Current capability status

| Capability | Status | Evidence boundary |
|---|---|---|
| Express runtime observation and evolved routes | Implemented | Unit, integration, and E2E tests |
| Fastify/generic observation | Implemented | Adapter-level behavior; no universal live swap parity |
| Runtime candidate, canary, promotion, rollback | Implemented | Component/integration tests; production traffic drill still required |
| Memory runtime version storage | Implemented | No implicit file persistence |
| File runtime version storage | Implemented | Atomic single-process writes and restart tests |
| Redis endpoint version storage | Implemented | Data model and lifecycle compile; real Redis/multi-process test pending |
| React/Vite/Next context detection | Implemented | React Router, Next App, and Next Pages tests |
| Application handoff and context index | Implemented | CLI, validation, index, and persistence tests |
| Goal/task control plane | Implemented for bounded task kinds | Frontend/backend task tests; arbitrary planning not claimed |
| Workspace verification and risk gates | Implemented | Safety, policy, command, and root-confinement tests |
| GitHub atomic PR publication | Implemented | Mocked API tests including stale hash and auto-merge |
| GitHub App short-lived authentication | Implemented | Signing and token-cache test |
| GitHub CI/deployment feedback repair | Implemented | Signature, dedupe, retry, allowlist, repair, circuit-breaker tests |
| Vercel workflow generation | Implemented | Workflow structure/validation tests; live account drill pending |
| AWS OIDC/ECR/ECS workflow generation | Implemented | Workflow structure/validation tests; live account drill pending |
| Postgres engineer/control-plane/feedback stores | Implemented through supplied clients | Mock query-client tests; no bundled driver |

## Repairs completed in this review

Additional security hardening completed:

- production Studio authentication cannot be disabled with `auth.enabled: false`;
- JavaScript project config loading is disabled by default and requires `SEIM_ALLOW_JS_CONFIG=true`;
- verification rejects symbolic links before copying or writing generated changes;
- Studio browser mutations require same-origin Origin/Host validation;
- schema table and field names are restricted to safe identifiers;
- generated frontend endpoints are constrained and safely serialized;
- engineer API errors return request IDs instead of internal exception details;
- retained Studio events redact code and secret-like fields.

The storage implementation previously contradicted its public type and documentation. This review corrected it:

- removed the fictional `sqlite` option;
- added a genuine in-memory version adapter;
- made `file` an explicit storage mode;
- stopped `memory` mode from silently creating learning, pattern, and changelog files;
- made file names collision-resistant while retaining legacy reads;
- serialized same-process file updates and made performance updates atomic;
- changed version and transition persistence from append-only duplication to ID-based upsert;
- persisted real transition origin, active/inactive status, rollback safety, and deprecation;
- removed duplicate rollback persistence;
- made all adapters enumerate route keys for restart loading;
- changed Redis from whole-array read/write updates to hashes and sorted sets;
- added Redis route discovery and graceful connection shutdown;
- made version and transition identifiers collision-resistant;
- added five regression tests covering these behaviors.

## Production pilot requirements

Before enabling autonomous pull requests or delivery for an application:

1. Build a baseline application with meaningful typecheck, unit, integration, browser, security, and acceptance checks.
2. Generate and review `.seim/handoff.json`; keep protected paths restrictive.
3. Begin with `observe`, `plan`, or `pull_request` autonomy.
4. Run the engineer worker in a dedicated least-privilege container or VM.
5. Require Studio authentication and restrict its network exposure.
6. Use GitHub App authentication or a narrowly scoped token.
7. Enable branch protection, CODEOWNERS, required checks, and protected deployment environments.
8. Use Postgres for durable engineer/control-plane/feedback state when multiple workers are involved.
9. Use Redis for endpoint version state when runtime replicas must agree, while accounting for non-centralized metrics/candidate/learning state.
10. Perform real preview, production, health-check, failure, and rollback drills for each Vercel or AWS target.
11. Monitor repair circuit-breaker events and require a human to resolve recurring failures.

## Remaining material gaps

### Isolation

Repository commands run in a copied temporary workspace with a scrubbed environment, but still execute as host child processes. This is not sufficient for hostile repositories. External container or VM isolation remains required.

### Distributed runtime state

Redis centralizes endpoint versions, transitions, and the active version. Metrics, candidate/artifact stores, learned patterns, and the product changelog are not all Redis-backed. Multi-replica autonomous runtime decisions can therefore lack a single global evidence set.

### General planning coverage

Concrete safe planners exist for selected backend and React/Next feature work, plus bounded AI-assisted CI repair. Authentication, billing, migration, data, operations, and arbitrary cross-cutting changes are not general autonomous capabilities and should remain specialist-reviewed.

### Live provider validation

GitHub, GitHub App, Vercel, AWS OIDC/ECR/ECS, Redis, and Postgres integrations need real service acceptance tests. Mocked API and generated-YAML tests prove package logic, not account permissions, cloud configuration, quotas, or provider behavior.

### Runtime framework parity

Express has the complete dynamic route path. Fastify and generic adapters do not currently offer identical live evolved-handler replacement semantics.

## Readiness decision

SEIM is suitable for a controlled pilot where:

- a real team owns the baseline and acceptance criteria;
- SEIM is limited to bounded, tested repository work;
- changes flow through pull requests and protected CI;
- deployment credentials and policy remain external and least privilege;
- unsupported or sensitive work stops for review;
- operators accept the persistence and isolation boundaries above.

SEIM is not yet suitable as an unsupervised replacement for a complete software team across arbitrary applications. Reaching that goal requires broader planners, hardened execution isolation, centralized distributed evidence, and repeated live-provider reliability drills.

The detailed implemented flows and trust boundaries are documented in [architecture.md](./architecture.md).
