# SEIM claim-validation results

**Validated:** 2026-08-30  
**Artifact:** locally packed `seim-core@1.0.6`, installed from `vendor/current/seim-core-1.0.6.tgz`

## Result

The application build and all 12 local package claims passed.

| Claim | Result |
|---|---|
| Existing Express baseline route remains functional | Pass |
| SEIM observes repeated backend traffic without changing the API response | Pass |
| Vite production HTML receives bounded SEIM sensor instrumentation | Pass |
| Studio rejects unauthenticated access | Pass |
| Authenticated status API and security headers work | Pass |
| Runtime metrics are available through the control plane | Pass |
| Frontend sensor JavaScript is served | Pass |
| Bounded frontend telemetry is accepted | Pass |
| Dashboard renders accessible tabs without the disabled merge action | Pass |
| React fallback generation safely treats intent as data | Pass |
| Handoff detects both the React frontend and Express backend | Pass |
| Generated Vercel/AWS workflows use secrets, AWS OIDC, production environments, and rollback entry points | Pass |

## Additional verification

- Validation app production build: passed with Vite 7.3.6 and a valid React-plugin peer dependency.
- Validation app dependency audit, including development dependencies: 0 vulnerabilities.
- SEIM TypeScript build: passed.
- SEIM Jest suite: 43 suites and 221 tests passed.
- SEIM production dependency audit: 0 vulnerabilities.
- SEIM package artifact: 468 files and a 332,121-byte archive (about 1.5 MB unpacked).
- Redis 7 live check: version and active state survived a SEIM production-mode restart.
- PostgreSQL 17 live check: an engineer job round-tripped through a temporary table that was then removed.
- Native production sandbox: `isolated-vm@5.0.4` loaded under Node 22 and passed an execution/isolation regression.

## Problems discovered during real-app validation

1. Rebuilding an artifact under the unchanged `1.0.4` version allowed npm to reuse stale locked contents. The verified runtime and bundled documentation are now represented by the immutable `1.0.6` patch artifact.
2. Static/Vite HTML streams bypassed the previous `res.send`-only instrumentation hook. SEIM now instruments bounded HTML responses flowing through Express `write`/`end`, preserves non-HTML streaming, skips HEAD responses, avoids duplicate sensor/style tags, and has regression coverage.
3. The initial workflow assertion expected one-line YAML, while the generated Vercel workflow correctly used `environment.name: production`. The acceptance check now recognizes the valid generated structure.
4. Selecting the Google AI provider without a custom URL still targeted OpenAI. SEIM now derives the Gemini `generateContent` endpoint from the selected Google model.
5. The old `isolated-vm` pin did not install on Node 22, and the real isolate path exposed incorrect global and function-transfer behavior. SEIM now uses the Node 18+ compatible 5.x line and regression-tests the native production path.

## Not claimed as live-verified

The provider harness is implemented, but these external production behaviors remain unverified:

- GitHub repository publication, branch protection, App installation tokens, and webhook delivery;
- Vercel preview/production deployment and rollback;
- AWS OIDC role assumption, ECR/ECS deployment, health checks, and rollback;
- Gemini model quality, availability, quotas, and billing;
- browser-level accessibility and visual regression behavior.

Redis and PostgreSQL were live-verified locally, not as multi-region managed services. External checks require rotated, scoped credentials supplied through the environment; credentials pasted into chat were deliberately not used and must be revoked before production.
