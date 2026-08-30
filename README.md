# SEIM

SEIM (`seim-core`) is a self-evolving application runtime and repository engineering control plane for an existing Node.js and React/Next.js web application.

Its intended operating model is: a developer builds and hands off a sound baseline application; SEIM then observes it, turns supported product signals or goals into bounded changes, verifies those changes, opens GitHub pull requests, and connects verified commits to Vercel or AWS ECS delivery workflows.

This is a working foundation, not a promise of fully unattended development for arbitrary software. Supported flows are tested; sensitive and unsupported work is blocked or left as explicit review work.

See [architecture.md](./architecture.md) for all runtime, handoff, planning, verification, GitHub, feedback, persistence, security, Vercel, and AWS flows.

## Verified status

Verified locally on 2026-08-30:

| Check | Result |
|---|---|
| TypeScript build | Passed |
| Jest | 43 suites passed |
| Tests | 221 passed |
| Package dry run | Passed |
| Runtime version restart/rollback regression tests | Passed |

Redis and PostgreSQL were live-verified through local containers. GitHub, Vercel, AWS, and Gemini remain external acceptance gates and require rotated, scoped credentials supplied through the environment.

## What is implemented

- Express request observation, metrics, behavior tracking, dynamic route handling, candidate evaluation, deterministic canaries, and rollback controls.
- Fastify and generic adapter integration for observation; live evolved-handler replacement is not equivalent to Express in the current release.
- Issue detection for repeated missing routes, 5xx patterns, and selected UX signals with basic scanner/noise filtering.
- React, Vite, Next App Router, Next Pages Router, and React Router context detection and bounded page/component planning.
- `.seim/handoff.json` as the developer-approved takeover contract.
- Repository context indexing for source, tests, API contracts, databases, design systems, documentation, workspaces, and deployment files.
- Goal decomposition into dependency-aware frontend, backend, review, and test tasks.
- Disposable-workspace verification with root confinement, static security checks, typecheck, tests, integration tests, build, and browser checks when configured.
- Risk-based stop, approval, pull-request, merge, and deploy boundaries.
- Atomic GitHub publication using one tree and one commit, stale-source hash checks, pull requests, and protected auto-merge requests.
- GitHub token or short-lived GitHub App installation authentication.
- Signed GitHub workflow/deployment feedback, deduplication, bounded retry, repair PRs, and a recurring-failure circuit breaker.
- Generated GitHub Actions for verification, Vercel preview/production/rollback, and AWS OIDC/ECR/ECS deployment/rollback.
- Truthful runtime storage modes: in-memory, single-writer file persistence, and Redis endpoint-version persistence.

## Support boundaries

| Area | Current support |
|---|---|
| Express backend | Runtime observation and dynamic evolved routes |
| Fastify/generic HTTP | Integration and observation; no equivalent universal live route swap |
| React/Vite | Context-aware component/page and route planning |
| Next.js | App Router and Pages Router file planning |
| Repository changes | Supported frontend/backend planners plus bounded AI CI repair |
| Auth, billing, secrets, migrations | Protected or approval-gated; no general autonomous planner |
| GitHub | PR publication, merge controls, App auth, signed delivery feedback |
| Vercel | Generated GitHub Actions for preview, production, health, rollback |
| AWS | Generated GitHub Actions using OIDC, ECR, ECS, health, rollback |
| Multi-replica state | Redis for endpoint versions only; other runtime stores are not centralized |

## Install

```bash
npm install seim-core
```

Node.js 18 or newer is required. Install optional integrations separately when used:

```bash
npm install redis isolated-vm
```

The package does not bundle a Postgres driver. Supply a Postgres-compatible query client through configuration.

## Express runtime integration

```js
const express = require('express');
const { seim } = require('seim-core');

const app = express();
const s = seim({
  mode: 'restrict',
  environment: 'development',
  framework: 'express',
  storage: { type: 'memory' },
  auth: {
    enabled: true,
    secret: process.env.SEIM_AUTH_SECRET,
  },
  behavior: {
    enabled: true,
    autoScaffold: false,
    minPatternFrequency: 3,
  },
});

app.use(express.json());
app.use(s.listener());
app.use(s.config.studioPath, s.dashboard);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

const server = app.listen(3000);

async function stop() {
  await s.shutdown();
  server.close();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
```

Start with `mode: 'restrict'`, no autonomous promotion, and memory storage during evaluation. Enable broader behavior only after project rules, tests, storage, Studio authentication, and rollback behavior are established.

## Storage

```ts
seim({ storage: { type: 'memory' } });
seim({ storage: { type: 'file' }, storagePath: '/durable/seim' });
seim({ storage: { type: 'redis', connection: process.env.REDIS_URL } });
```

- `memory` is process-local and writes no runtime version files. Production configuration rejects it.
- `file` atomically persists endpoint versions and is intended for one writer on durable local storage.
- `redis` uses hashes, sorted sets, active-version keys, and a route registry for restart-safe endpoint version state. Install `redis` separately.

Redis does not currently centralize runtime metrics, candidate/artifact stores, learned patterns, or the changelog. Those limitations matter in multi-replica deployments; see the persistence section in [architecture.md](./architecture.md).

## Hand off an existing application

From the application repository:

```bash
npx seim handoff .
```

Review the generated `.seim/handoff.json`. The default contract uses `pull_request` autonomy and protects `.env`, `.git`, and secret paths. Configure:

- frontend, backend, tests, design-system, and database ownership paths;
- typecheck, test, integration, build, and browser commands;
- protected and approval-required paths;
- autonomy: `observe`, `plan`, `pull_request`, `merge`, or `deploy`;
- Vercel or AWS ECS delivery targets.

The application can then be registered and given a goal:

```ts
const s = seim({
  mode: 'restrict',
  storage: { type: 'file' },
  engineer: {
    enabled: true,
    rootDir: process.cwd(),
    repository: 'github',
    persistence: 'file',
    github: {
      owner: 'acme',
      repository: 'storefront',
      token: process.env.SEIM_GITHUB_TOKEN,
    },
  },
});

const application = await s.engineer.handoffApplication(process.cwd());
const plan = await s.engineer.submitGoal({
  applicationId: application.id,
  title: 'Add a cart dashboard',
  description: 'Build /cart in the existing React app and GET /api/cart in the backend.',
  acceptanceCriteria: [
    'Users can see cart items',
    'The API returns only the current user cart',
    'Existing tests remain green',
  ],
});

await s.engineer.runPlan(plan.id);
```

Executable supported tasks proceed through policy and verification. Sensitive review tasks, unsupported tasks, and acceptance-test work remain visible until completed or approved through the control plane.

## GitHub authentication

Use either a scoped token or a GitHub App. GitHub App mode avoids a long-lived personal token:

```ts
engineer: {
  repository: 'github',
  github: {
    owner: 'acme',
    repository: 'storefront',
    app: {
      appId: process.env.SEIM_GITHUB_APP_ID,
      installationId: process.env.SEIM_GITHUB_INSTALLATION_ID,
      privateKey: process.env.SEIM_GITHUB_PRIVATE_KEY,
    },
  },
}
```

Use least-privilege GitHub permissions, branch protection, required checks, CODEOWNERS, and protected environments. `merge` or `deploy` autonomy only requests actions allowed by those external policies.

## Getting and storing credentials

Create credentials for a disposable test environment before connecting production accounts. Never put real values in `.seimrc.json`, `.seim/handoff.json`, workflow YAML, source code, or committed `.env` files. Use a deployment secret manager for secrets. GitHub Actions variables are visible configuration and are appropriate only for non-secret identifiers such as project IDs, regions, resource names, and role ARNs.

If a credential is pasted into chat, terminal output, an issue, or a commit, treat it as exposed: revoke it, create a replacement, and update the secret store.

### SEIM Studio credential

Generate an independent random credential; do not reuse a GitHub, cloud, database, or AI token:

```bash
openssl rand -hex 32
```

Store the result as `SEIM_AUTH_SECRET` in the server/container secret manager. SEIM accepts it through `Authorization: Bearer <value>`, `x-seim-key`, or `x-api-key`. For browser Basic Auth, set a separate `SEIM_ADMIN_PASSWORD` and optionally configure `auth.username`. Production fails closed when no Studio credential is configured.

### GitHub repository authentication

A GitHub App is recommended for an organization or long-running installation because SEIM exchanges its private key for short-lived installation tokens. A fine-grained personal access token is suitable for a short disposable pilot. GitHub recommends minimum permissions, expirations, secure storage, and GitHub Apps for organization integrations; see [GitHub credential security](https://docs.github.com/en/rest/authentication/keeping-your-api-credentials-secure).

For a GitHub App:

1. In GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub App**. Organization-owned apps are created from the organization settings.
2. Grant repository access only to the target test repository. Start with **Contents: Read and write** and **Pull requests: Read and write**. Add **Actions: Read and write** only when delivery feedback may inspect and rerun failed jobs. Add **Workflows: Read and write** only if SEIM is allowed to publish `.github/workflows` changes. GitHub documents the permission model in [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).
3. Install the app on the target repository.
4. Copy the **App ID** from the app settings page.
5. Copy the numeric installation ID from the installation URL (`.../installations/<id>`) or the GitHub installation API.
6. Under **Private keys**, generate a PEM private key. Store the PEM in a secret manager. SEIM accepts either real newlines or `\n`-escaped newlines.

Set these runtime secrets:

```bash
SEIM_GITHUB_APP_ID=123456
SEIM_GITHUB_INSTALLATION_ID=12345678
SEIM_GITHUB_PRIVATE_KEY='-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----'
```

For a short-lived fine-grained token, use **GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**, restrict it to the target repository, set an expiration, and grant the same minimum repository permissions. Store it as `SEIM_GITHUB_TOKEN`. See [GitHub's token creation guide](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

### GitHub webhook secret

Generate a different high-entropy value:

```bash
openssl rand -hex 32
```

Set this exact value as the webhook **Secret** in GitHub and as `SEIM_GITHUB_WEBHOOK_SECRET` in the SEIM runtime. Configure the webhook payload URL to the route where `s.githubWebhook` is mounted, use `application/json`, and subscribe only to `workflow_run` and `deployment_status`. GitHub explains why and how signatures are checked in [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

### Vercel credentials

1. Create or import the target project in Vercel.
2. Open the Vercel account/team settings and create an access token. Store it as the GitHub Actions repository or environment secret `VERCEL_TOKEN`; see [Vercel API access tokens](https://vercel.com/kb/guide/how-do-i-use-a-vercel-api-access-token).
3. From the application directory, run `npx vercel link`. Read `orgId` and `projectId` from the generated `.vercel/project.json`. Vercel also documents these non-interactive identifiers in its [CLI global options](https://vercel.com/docs/cli/global-options).
4. In **GitHub repository → Settings → Secrets and variables → Actions**, add `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` as variables. The generated SEIM workflows reference `vars.VERCEL_ORG_ID` and `vars.VERCEL_PROJECT_ID`, while the token is read from `secrets.VERCEL_TOKEN`.
5. Create GitHub `preview` and `production` environments as required by your policy. Add required reviewers and restrict production deployment branches.

Do not commit `.vercel/project.json` merely to distribute credentials; the IDs are not passwords, but repository variables keep environment configuration separate from source.

### AWS ECS credentials through GitHub OIDC

SEIM's generated AWS workflows deliberately do not use `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY`.

1. In AWS IAM, add the GitHub OIDC provider `https://token.actions.githubusercontent.com` with audience `sts.amazonaws.com`.
2. Create an IAM role trusted by that provider. Restrict the trust policy `sub` condition to the exact GitHub organization, repository, and `production` environment used by the generated workflow. GitHub's current setup is documented in [Configuring OIDC in AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws), and AWS documents the console flow in [Create a role for OIDC federation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html).
3. Attach a least-privilege policy for only the required ECR repository, ECS cluster/service, task-definition registration, and `iam:PassRole` targets. Avoid account-wide managed administrator policies.
4. Create the ECR repository, ECS cluster, ECS service, task execution role, and checked-in ECS task definition before enabling deployment.
5. Add these non-secret GitHub Actions variables:

```text
AWS_ROLE_ARN=arn:aws:iam::<account-id>:role/<github-oidc-role>
AWS_REGION=<region>
AWS_ECR_REPOSITORY=<repository-name>
AWS_ECS_CLUSTER=<cluster-name>
AWS_ECS_SERVICE=<service-name>
AWS_HEALTHCHECK_URL=https://<optional-health-endpoint>
```

The workflow requests `id-token: write`, exchanges GitHub's OIDC token for temporary AWS credentials, and never needs a long-lived AWS key.

### Redis connection

Create a Redis database through Redis Cloud or your chosen managed provider, create a least-privilege data user, and copy its TLS endpoint, username, and password. Store the assembled URI as `REDIS_URL`:

```text
rediss://<username>:<url-encoded-password>@<host>:<port>/<database>
```

Use `rediss://` for TLS. Redis documents the URI format in [redis-cli connection strings](https://redis.io/docs/latest/develop/tools/cli/) and where to retrieve managed connection details in [Connect to Redis Cloud](https://redis.io/docs/latest/operate/rc/databases/connect/). Pass the value through `storage.connection`; SEIM reads no Redis credential from source files:

```ts
storage: { type: 'redis', connection: process.env.REDIS_URL }
```

### Postgres connection

Create a dedicated database and a dedicated login role with access only to the SEIM tables/schema. Obtain the host, port, database, username, password, and CA certificate from the database provider. Store a TLS connection URI as `DATABASE_URL`; PostgreSQL documents the URI format and TLS modes in [Connection strings](https://www.postgresql.org/docs/current/libpq-connect.html).

SEIM does not open `DATABASE_URL` itself. Create a compatible query pool/client and pass it into `engineer.postgres.client`:

```ts
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { ca: process.env.POSTGRES_CA_CERT },
});

const s = seim({
  engineer: {
    enabled: true,
    persistence: 'postgres',
    postgres: { client: pool },
  },
});
```

Prefer certificate verification (`verify-full` or the equivalent supported by the Node driver/provider) rather than disabling TLS verification. PostgreSQL recommends `verify-full` for security-sensitive connections in its [SSL guidance](https://www.postgresql.org/docs/current/libpq-ssl.html).

### Optional AI provider key

Create a server-side project key from the selected provider: [OpenAI API keys](https://platform.openai.com/docs/api-reference/authentication), [Anthropic Console](https://console.anthropic.com/settings/keys), [Google AI Studio](https://ai.google.dev/gemini-api/docs/get-started), or [xAI Console](https://console.x.ai/). Restrict the project/key where the provider supports it, set billing and rate limits, and store it in your runtime secret manager.

SEIM does not automatically read an AI environment-variable name. Map your secret explicitly to `ai.apiKey`, and set the provider and models available to your account. Built-in providers derive their standard endpoint automatically; use `baseUrl` only for a custom or proxy endpoint:

```ts
ai: {
  enabled: true,
  provider: 'google',
  apiKey: process.env.SEIM_AI_API_KEY,
  generatorModel: 'gemini-2.5-flash',
  reviewerModel: 'gemini-2.5-flash',
  verifierModel: 'gemini-2.5-flash',
}
```

For OpenAI-compatible providers use their chat-completions endpoint; Anthropic uses `https://api.anthropic.com/v1/messages`; xAI uses `https://api.x.ai/v1/chat/completions`. Pin models deliberately and run the package's verification/evaluation checks before trusting a new model version.

### Credential checklist

| Capability | Secret/runtime value | Non-secret GitHub Actions variables |
|---|---|---|
| Studio | `SEIM_AUTH_SECRET` or `SEIM_ADMIN_PASSWORD` | None |
| GitHub repository | `SEIM_GITHUB_TOKEN`, or App ID + installation ID + private key | None |
| GitHub feedback | `SEIM_GITHUB_WEBHOOK_SECRET` | None |
| Vercel | `VERCEL_TOKEN` GitHub Actions secret | `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` |
| AWS ECS | No long-lived AWS secret; GitHub OIDC supplies temporary credentials | `AWS_ROLE_ARN`, `AWS_REGION`, `AWS_ECR_REPOSITORY`, `AWS_ECS_CLUSTER`, `AWS_ECS_SERVICE`, optional `AWS_HEALTHCHECK_URL` |
| Redis | `REDIS_URL` | None |
| Postgres | `DATABASE_URL` and optional CA secret, mapped into a query client | None |
| AI | Provider key mapped to `ai.apiKey` | None |

## Vercel and AWS ECS delivery

Generate workflows from the reviewed handoff:

```bash
npx seim delivery . --vercel --aws
```

This creates a reusable verification workflow plus provider deployment and manual rollback workflows.

For Vercel, configure:

- secret `VERCEL_TOKEN`;
- variables `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`.

For AWS ECS, configure:

- variables `AWS_ROLE_ARN`, `AWS_REGION`, `AWS_ECR_REPOSITORY`, `AWS_ECS_CLUSTER`, and `AWS_ECS_SERVICE`;
- optional variable `AWS_HEALTHCHECK_URL`;
- a checked-in task definition and the correct application container name in the handoff target.

AWS authentication uses GitHub OIDC. Do not create long-lived AWS access-key secrets for these workflows. Configure required reviewers and branch restrictions on the GitHub `production` environment.

## GitHub delivery feedback

Enable feedback only with a GitHub repository provider, repository authentication, and a webhook secret:

```ts
engineer: {
  enabled: true,
  repository: 'github',
  persistence: 'postgres',
  postgres: { client: pool },
  github: { owner: 'acme', repository: 'storefront', token: process.env.SEIM_GITHUB_TOKEN },
  feedback: {
    enabled: true,
    webhookSecret: process.env.SEIM_GITHUB_WEBHOOK_SECRET,
    allowedBranches: ['main'],
    allowedWorkflowPrefixes: ['SEIM'],
    maxTransientRetries: 1,
    maxRepairsPerFingerprint: 2,
  },
}
```

Mount `s.githubWebhook` with `express.raw({ type: 'application/json', limit: '1mb' })` before JSON parsing. Signature verification requires the exact raw request bytes. Subscribe the GitHub webhook to `workflow_run` and `deployment_status` events.

## CLI

```bash
npx seim init
npx seim handoff .
npx seim delivery . --vercel --aws
npx seim status http://localhost:3000
npx seim analyze ./routes/users.js
npx seim benchmark http://localhost:3000/api/health
npx seim rollback /api/users
npx seim apply .
```

## Safety model

SEIM uses several independent gates:

- developer-approved handoff policy and autonomy;
- project-root confinement and path normalization;
- protected and approval-required paths;
- sensitive-code and critical-change rejection;
- expected source hashes to reject stale updates;
- disposable verification workspace and scrubbed secret-like environment variables;
- configured project checks and required browser testing for frontend changes;
- pull requests, branch protection, required reviews, and protected deployment environments;
- signed and deduplicated GitHub webhooks with allowlists and a failure circuit breaker;
- deterministic canary assignment and runtime rollback controls.

The built-in workspace and JavaScript sandbox are not OS isolation boundaries. Run repository verification in a dedicated least-privilege container or VM before allowing it to process untrusted repositories or commands.

JavaScript project configuration is not executed during discovery by default. Trusted local projects may opt in with `SEIM_ALLOW_JS_CONFIG=true`. Engineer verification rejects symbolic links, and browser-based Studio mutations must be same-origin.

## What SEIM does not yet guarantee

- fully autonomous development of arbitrary requirements;
- safe unsupervised auth, authorization, payment, billing, secret, or migration changes;
- central multi-replica persistence for all runtime state;
- identical runtime hot swapping across Express, Fastify, and generic HTTP;
- production correctness without application-specific tests and acceptance criteria;
- cloud delivery without operator-owned GitHub, Vercel, AWS, IAM, and rollback configuration;
- hostile-code isolation inside the Node.js process.

These are the current engineering boundaries. The package is designed to stop or request review when it cannot establish a safe path.

## Development

```bash
npm run build
npm test -- --runInBand
npm pack --dry-run --json
```

The current baseline is 43 passing suites and 221 passing tests.

To rerun the packed-package validation app:

```bash
cd claim-validation-app
npm test
REDIS_URL=redis://127.0.0.1:56379 DATABASE_URL='postgresql://user:password@127.0.0.1:5432/database' npm run check:providers
```

The provider harness reads credentials only from environment variables and never needs them committed to the repository. External checks use:

- `SEIM_AI_API_KEY` and optional `SEIM_AI_MODEL`;
- `SEIM_GITHUB_APP_ID`, `SEIM_GITHUB_INSTALLATION_ID`, `SEIM_GITHUB_PRIVATE_KEY`, `SEIM_GITHUB_OWNER`, and `SEIM_GITHUB_REPOSITORY`;
- `VERCEL_TOKEN` and optional `VERCEL_ORG_ID` plus `VERCEL_PROJECT_ID`;
- `REDIS_URL` and `DATABASE_URL`.

Do not paste provider secrets into chat, issues, logs, shell history, or configuration files. Revoke any credential that has been exposed, create a replacement with the minimum required scope, and inject it through the runtime or CI secret manager.

## License

MIT. See [LICENSE](./LICENSE).
