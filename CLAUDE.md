# SEIM contributor guidance

SEIM is a two-plane self-evolving application package: a runtime observation/evolution plane and a governed repository engineering plane. Read [architecture.md](./architecture.md) before changing cross-cutting behavior.

## Verification

```bash
npm run build
npm test -- --runInBand
npm pack --dry-run --json
```

Current verified baseline: 42 suites and 206 tests.

## Invariants

- Preserve existing application behavior unless equivalence and configured acceptance checks pass.
- Keep request-path work bounded and move analysis off the hot path.
- Use `.unref()` for background timers that must not hold the process open.
- Keep generated paths inside the handed-off repository root.
- Never weaken protected paths, risk approval, stale-source hashes, webhook verification, branch protection, or cloud identity boundaries.
- Treat auth, authorization, payment, billing, secrets, migrations, and infrastructure as sensitive work.
- Do not describe process-level workspaces or the JavaScript sandbox as OS isolation.
- Keep documentation aligned with tested source behavior and list external validation separately.
