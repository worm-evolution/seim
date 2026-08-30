# SEIM architecture

This document describes the architecture implemented in `seim-core` v1.0.6. It is intentionally a code-level description, not a claim that SEIM can replace every engineering specialty without project-specific policy, tests, credentials, and human ownership.

SEIM has two complementary evolution planes:

1. The runtime plane observes a running Node.js application, detects route and behavior signals, evaluates bounded candidates, and can route or roll back supported Express handlers.
2. The repository plane takes over an existing baseline repository, indexes its React/Next and backend context, converts issues or product goals into governed tasks, verifies changes in a disposable workspace, and publishes GitHub pull requests. Generated GitHub Actions workflows deliver verified commits to Vercel or AWS ECS.

## System context

```mermaid
flowchart LR
    User["Application users"] --> App["Baseline web application"]
    Founder["Founder or engineering owner"] --> Studio["SEIM Studio and typed API"]
    App --> Runtime["SEIM runtime plane"]
    Runtime --> Signals["Metrics, behavior, issues, versions"]
    Signals --> Engineer["SEIM repository engineer"]
    Studio --> Engineer
    Engineer --> Workspace["Disposable verification workspace"]
    Engineer --> GitHub["GitHub repository and pull requests"]
    GitHub --> Actions["GitHub Actions verification"]
    Actions --> Vercel["Vercel"]
    Actions --> AWS["AWS ECR and ECS"]
    GitHub --> Feedback["Signed workflow and deployment webhooks"]
    Feedback --> Engineer
    Runtime --> Storage["Memory, file, or Redis version state"]
    Engineer --> Durable["Memory, file, or supplied Postgres stores"]
    Runtime -. optional .-> AI["Configured AI provider"]
    Engineer -. optional .-> AI
```

The application remains the execution boundary. SEIM does not own the application's database, cloud account, GitHub organization, or production policy. Those remain external systems controlled by the operator.

## Component map

```mermaid
flowchart TB
    subgraph RuntimePlane["Runtime plane"]
        Listener["Framework listener"]
        Metrics["Metrics and endpoint tracker"]
        Behavior["Behavior tracker"]
        Issues["Issue stream"]
        Optimize["Optimization and evolution engines"]
        Validate["Security, validation, sandbox, shadow"]
        Dispatch["Version dispatcher and dynamic router"]
        Rollback["Canary and rollback controls"]
        Learning["Learning, patterns, changelog"]
        Listener --> Metrics
        Listener --> Behavior
        Metrics --> Optimize
        Behavior --> Issues
        Issues --> Optimize
        Optimize --> Validate
        Validate --> Dispatch
        Dispatch --> Rollback
        Rollback --> Learning
    end

    subgraph RepositoryPlane["Repository engineering plane"]
        Handoff["Handoff contract"]
        Index["Project context index"]
        Control["Application control plane"]
        Planner["Issue and CI repair planners"]
        Policy["Risk policy"]
        Executor["Workspace executor"]
        Repository["Memory or GitHub provider"]
        Delivery["Delivery workflow generator"]
        FeedbackLoop["GitHub feedback loop"]
        Handoff --> Index --> Control --> Planner --> Policy --> Executor --> Repository
        Handoff --> Delivery
        FeedbackLoop --> Planner
    end

    Issues --> Control
    Repository --> FeedbackLoop
```

## Runtime request flow

The Express listener is the most complete runtime integration. It records telemetry, permits a dynamically registered route to answer first, and otherwise delegates to the existing application. Fastify and generic adapters provide integration and observability, but the current package does not provide equivalent live handler replacement for every framework.

```mermaid
sequenceDiagram
    participant Client
    participant Listener as SEIM listener
    participant Router as Dynamic router
    participant App as Existing application
    participant Metrics as Metrics and behavior stores
    participant Worker as Optimization worker

    Client->>Listener: HTTP request
    Listener->>Metrics: Start request and behavior observation
    Listener->>Router: Check normalized method and path
    alt evolved Express handler exists
        Router->>Client: Execute registered handler
    else no evolved handler
        Listener->>App: next or framework delegation
        App->>Client: Existing response
    end
    Listener->>Metrics: Record latency, status, and response size
    Metrics-->>Worker: Queue eligible hot or failing route
```

Request interception is not the same as repository evolution. A runtime optimization may affect an in-process route; a repository change must still pass the engineering workflow before it becomes source code.

## Runtime candidate lifecycle

```mermaid
flowchart TD
    Observe["Observe enough route samples"] --> Analyze["Analyze latency, errors, throughput, and patterns"]
    Analyze -->|No actionable signal| Cooldown["Skip or enter cooldown"]
    Analyze -->|Actionable| Generate["Generate bounded candidates"]
    Generate --> Security["Security and policy checks"]
    Security -->|Blocked| Reject["Reject and learn failure"]
    Security -->|Allowed| Sandbox["Sandbox execution"]
    Sandbox -->|Diverges or fails| Reject
    Sandbox --> Shadow["Read-only shadow samples"]
    Shadow -->|Insufficient evidence| Wait["Collect more samples"]
    Wait --> Shadow
    Shadow -->|Regression| Reject
    Shadow -->|Equivalent and improved| Decision{"Autonomous promotion enabled?"}
    Decision -->|No| Review["Manual review"]
    Decision -->|Yes| Canary["Deterministic canary"]
    Review --> Canary
    Canary -->|Healthy| Promote["Promote active version"]
    Canary -->|Latency or error regression| Rollback["Rollback to safe version"]
    Promote --> Learn["Persist version, transition, pattern, and changelog"]
    Rollback --> Learn
```

Shadow execution defaults to safe HTTP methods. It marks cloned requests with `isShadow` and `x-seim-shadow`; application integrations must use those signals to suppress external side effects. This marker is a contract, not a transaction boundary around third-party systems.

## Behavior-driven product issue flow

```mermaid
flowchart LR
    Events["404s, 5xx responses, UX events, telemetry"] --> Aggregate["Bounded behavior aggregation"]
    Aggregate --> Noise["Scanner and noise filtering"]
    Noise --> Sessions{"Enough distinct sessions?"}
    Sessions -->|No| Retain["Retain bounded evidence"]
    Sessions -->|Yes| Issue["Create ProductIssue"]
    Issue --> Mode{"Configured evolution path"}
    Mode -->|Runtime scaffold| Scaffold["Backend scaffolder or frontend evolver"]
    Mode -->|Repository engineer| Job["Governed engineer job"]
    Scaffold --> Dynamic["Dynamic route or generated frontend artifact"]
    Job --> PR["Verified pull request"]
    Dynamic --> Changelog["Evolution changelog"]
    PR --> Changelog
```

`feature:missing_api` and `feature:missing_page` have concrete planners. Unsupported goals remain visible as manual review/test tasks instead of being silently invented.

## Application handoff and context indexing

The takeover boundary is `.seim/handoff.json`. It records ownership paths, project commands, delivery targets, autonomy, protected paths, and approval-required paths.

```mermaid
sequenceDiagram
    participant Developer
    participant CLI as seim handoff
    participant Adapter as ProjectAdapter
    participant Contract as .seim/handoff.json
    participant Control as ApplicationControlPlane
    participant Store as Control-plane store

    Developer->>CLI: seim handoff application-root
    CLI->>Adapter: Inspect repository
    Adapter->>Adapter: Detect package manager, scripts, backend, React or Next router
    Adapter->>Adapter: Index source, tests, API, database, design, docs, and deployment files
    CLI->>Contract: Write restrictive default contract atomically
    Developer->>Contract: Review policies, commands, targets, and autonomy
    Control->>Adapter: Re-inspect with approved contract
    Control->>Store: Persist application registration and fingerprint
```

The index is bounded to 5,000 discovered files and marks itself as truncated when that limit is reached. It indexes metadata and selected paths; it is not a semantic understanding of every line in a large repository.

## Goal-to-task control flow

```mermaid
flowchart TD
    Goal["Goal plus acceptance criteria"] --> App["Resolve handed-off application"]
    App --> Decompose["Detect frontend, backend, data, security, test, and release intent"]
    Decompose --> Frontend["Executable frontend task when supported"]
    Decompose --> Backend["Executable backend task when supported"]
    Decompose --> Review["Manual sensitive-impact review"]
    Decompose --> Tests["Visible acceptance and regression task"]
    Review --> Backend
    Backend --> Frontend
    Frontend --> Tests
    Backend --> Tests
    Tests --> PlanState{"All tasks complete?"}
    PlanState -->|Yes| Complete["Goal completed"]
    PlanState -->|Approval pending| Approval["Goal awaiting approval"]
    PlanState -->|Unsupported dependency| Blocked["Goal blocked with reason"]
    PlanState -->|Execution failure| Failed["Goal failed with evidence"]
```

The current control plane decomposes goals deterministically from goal text and the project manifest. It does not yet provide a general-purpose autonomous product manager for arbitrary requirements.

## Engineer job state machine

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> verifying: run
    verifying --> rejected: policy blocked or verification failed
    verifying --> awaiting_approval: medium or high risk
    verifying --> pr_open: low risk and verified
    awaiting_approval --> pr_open: explicit approval
    pr_open --> approved: permitted merge succeeds
    approved --> deployed: release provider succeeds
    deployed --> rolled_back: configured release rollback
    rejected --> [*]
    failed --> [*]
    rolled_back --> [*]
```

The `planning` status exists in the type model, but current `submit()` creates the plan before persisting the queued job. The normal persisted path is therefore `queued -> verifying`.

## Change planning, risk, and verification

```mermaid
flowchart TD
    Issue["Product issue or GitHub failure"] --> Planner["Template planner or bounded AI repair planner"]
    Planner --> Hashes["Attach expected SHA-256 for updates"]
    Hashes --> Risk["Evaluate handoff and built-in risk policy"]
    Risk -->|Observe or plan autonomy| Stop["Block repository execution"]
    Risk -->|Protected path or critical| Stop
    Risk -->|Allowed| Copy["Copy repository without .git to temporary workspace"]
    Copy --> Apply["Apply changes inside project root"]
    Apply --> Static["Static security scan"]
    Static --> Commands["Typecheck, test, integration, build"]
    Commands --> Frontend{"Frontend files changed?"}
    Frontend -->|Yes| Browser["Required browser command when policy requires it"]
    Frontend -->|No| Report["Verification report"]
    Browser --> Report
    Report -->|Any failed or skipped required check| Reject["Reject"]
    Report -->|Passed and approval needed| Human["Await explicit approval"]
    Report -->|Passed and low risk| Publish["Publish pull request"]
    Human --> Publish
```

The disposable workspace is process-level isolation. Commands execute on the host with secret-like environment variables removed; this is not a hardened container, microVM, or hostile-code sandbox. Production operators should run the engineer worker in an externally isolated container or VM with least-privilege credentials.

Before verification, SEIM rejects symbolic links in the application tree and validates every planned write path. This prevents lexical path checks from being bypassed through filesystem links; it does not replace OS-level worker isolation.

## React and Next.js change planning

```mermaid
flowchart TD
    Manifest["Detected frontend context"] --> Framework{"Framework and router"}
    Framework -->|Next App Router| AppPage["Create page in app route segment"]
    Framework -->|Next Pages Router| PagesPage["Create page in pages directory"]
    Framework -->|React Router| Component["Generate TSX component"]
    Component --> Routes["Update detected Routes tree"]
    Framework -->|Unknown| Review["Keep behind verification or manual review"]
    AppPage --> Consistency["Consistency and dependency checks"]
    PagesPage --> Consistency
    Routes --> Consistency
    Consistency --> Workspace["Project typecheck, tests, build, and browser checks"]
```

The context includes detected dependencies, styling libraries, state libraries, data libraries, known routes, entrypoints, and router kind. Generation reuses that context, but visual quality and business correctness still depend on acceptance criteria and project tests.

## GitHub publication flow

```mermaid
sequenceDiagram
    participant Engineer
    participant GitHub as GitHub API
    participant Protection as Branch protection and CI
    participant Owner

    Engineer->>GitHub: Read base ref, commit, and recursive tree
    Engineer->>GitHub: Verify expected source hashes
    Engineer->>GitHub: Create blobs for changed files
    Engineer->>GitHub: Create one tree and one commit
    Engineer->>GitHub: Create seim branch at commit
    Engineer->>GitHub: Open pull request to base branch
    alt handoff autonomy is merge or deploy
        Engineer->>GitHub: Request protected auto-merge
        GitHub->>Protection: Wait for required checks and reviews
    else pull_request autonomy
        GitHub->>Owner: Request review
    end
    Owner->>GitHub: Approve or invoke permitted merge
```

Authentication supports a static token or a GitHub App installation token provider. GitHub App mode signs a short-lived JWT and caches the short-lived installation token. Branch protection remains the authoritative merge gate.

## GitHub failure and repair loop

```mermaid
sequenceDiagram
    participant GitHub
    participant Webhook as Signed webhook handler
    participant Store as Feedback store
    participant Client as GitHub Actions client
    participant Engineer

    GitHub->>Webhook: workflow_run or deployment_status
    Webhook->>Webhook: Enforce body limit and verify HMAC signature
    Webhook->>Store: Claim delivery identifier for deduplication
    Webhook->>Webhook: Check repository, workflow prefix, and branch allowlist
    alt transient workflow failure and branch still at failed SHA
        Webhook->>Client: Re-run failed jobs once
        Webhook->>Store: Mark retrying
    else actionable persistent or stale failure
        Webhook->>Client: Read failed steps and branch head
        Webhook->>Store: Compute failure fingerprint and check circuit breaker
        Webhook->>Engineer: Submit bounded CI repair issue
        Engineer-->>Webhook: Rejected job or verified repair PR
        Webhook->>Store: Persist outcome
    else healthy or irrelevant event
        Webhook->>Store: Mark resolved or ignored
    end
```

The default circuit breaker allows at most two prior equivalent repair attempts per fingerprint. The loop only acts on configured repositories, branches, and SEIM workflow names or paths.

## Vercel delivery flow

```mermaid
flowchart LR
    PR["Pull request"] --> Verify["Reusable SEIM verification workflow"]
    Verify --> Preview["Vercel preview build and deploy"]
    Preview --> PreviewHealth["Preview URL health check"]
    Merge["Push to production branch"] --> VerifyProd["Reusable verification"]
    VerifyProd --> Env["Protected GitHub production environment"]
    Env --> Prod["Vercel production build and deploy"]
    Prod --> Health["Configured production health check"]
    Failure["Manual rollback request"] --> Env
    Env --> Rollback["Vercel rollback and status"]
```

Required GitHub configuration: secret `VERCEL_TOKEN`; variables `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`. The workflows use provider CLIs at execution time, so pinning and organization policy should be reviewed before production use.

## AWS ECS delivery flow

```mermaid
flowchart LR
    Push["Push to production branch"] --> Verify["Reusable SEIM verification"]
    Verify --> Env["Protected GitHub production environment"]
    Env --> OIDC["GitHub OIDC assumes AWS role"]
    OIDC --> Build["Build container image"]
    Build --> ECR["Push immutable SHA tag to ECR"]
    ECR --> Render["Render checked-in ECS task definition"]
    Render --> ECS["Deploy task definition to ECS service"]
    ECS --> Stable["Wait for service stability and health check"]
    Manual["Manual rollback request"] --> Env
    Env --> Previous["Select or provide known task definition"]
    Previous --> ECS
```

Required GitHub variables: `AWS_ROLE_ARN`, `AWS_REGION`, `AWS_ECR_REPOSITORY`, `AWS_ECS_CLUSTER`, `AWS_ECS_SERVICE`, and optional `AWS_HEALTHCHECK_URL`. AWS access keys are not generated; OIDC and a least-privilege role are required.

## Persistence ownership

```mermaid
flowchart TB
    Config{"storage.type"}
    Config -->|memory| Memory["In-process version state"]
    Config -->|file| File["Atomic route JSON files"]
    Config -->|redis| Redis["Redis hashes, sorted sets, active keys, route registry"]
    EngineerConfig{"engineer.persistence"}
    EngineerConfig -->|memory| EngineerMemory["In-process jobs and plans"]
    EngineerConfig -->|file| EngineerFile["File jobs and control-plane records"]
    EngineerConfig -->|postgres| Postgres["Supplied Postgres-compatible client"]
    FeedbackConfig{"feedback persistence follows engineer configuration"}
    FeedbackConfig --> FeedbackMemory["Memory"]
    FeedbackConfig --> FeedbackFile["File"]
    FeedbackConfig --> FeedbackPostgres["Supplied Postgres client"]
```

| State | Memory | File | Redis/Postgres |
|---|---|---|---|
| Endpoint versions, transitions, active version | Yes | Yes | Redis |
| Runtime metrics | Yes | No | No |
| Candidate and artifact stores | Yes | Yes | File-backed when runtime storage is Redis |
| Learning patterns and changelog | Yes | Yes | File-backed when runtime storage is Redis |
| Engineer jobs and plans | Yes | Yes | Supplied Postgres client |
| GitHub feedback records | Yes | Yes | Supplied Postgres client |

Redis therefore shares endpoint version state across processes without whole-array lost updates. It is not a distributed transaction coordinator, and it does not currently centralize every runtime metric, candidate, artifact, or learning store. File storage is suitable for a single writer on durable local storage, not multiple replicas sharing a network filesystem.

## Security and trust boundaries

```mermaid
flowchart TB
    Internet["Untrusted internet"] --> AppBoundary["Application authentication and network boundary"]
    AppBoundary --> StudioAuth["Studio auth guard"]
    Internet --> WebhookBoundary["Webhook body limit and HMAC verification"]
    WebhookBoundary --> FeedbackLoop["Allowlisted GitHub feedback"]
    GoalInput["Goal or generated change"] --> PathBoundary["Root confinement and handoff path policy"]
    PathBoundary --> RiskBoundary["Sensitive-code and critical-change policy"]
    RiskBoundary --> WorkspaceBoundary["Disposable workspace and scrubbed environment"]
    WorkspaceBoundary --> GitHubBoundary["Hash checks, PR, branch protection"]
    GitHubBoundary --> CloudBoundary["Protected environment and least-privilege cloud identity"]
```

Security invariants implemented in code include repository-root confinement, protected paths, approval paths, sensitive-code checks, stale-source hash refusal, signed webhook verification, delivery deduplication, branch/workflow allowlists, bounded webhook bodies, secret-like environment scrubbing for verification commands, and production rejection of volatile runtime storage.

These controls do not replace application authorization, dependency scanning, cloud IAM review, code-owner review, a hardened worker sandbox, or security testing.

## Autonomy levels

| Handoff autonomy | Observe/index | Plan goals | Verify changes | Open PR | Merge | Deploy |
|---|---:|---:|---:|---:|---:|---:|
| `observe` | Yes | Yes | No | No | No | No |
| `plan` | Yes | Yes | No | No | No | No |
| `pull_request` | Yes | Yes | Yes | Yes | No | No |
| `merge` | Yes | Yes | Yes | Yes | Through GitHub policy | No direct release provider by default |
| `deploy` | Yes | Yes | Yes | Yes | Through GitHub policy | Through generated workflows or configured release provider |

Risk policy can reduce autonomy but cannot expand it. Critical changes and protected paths remain blocked. Medium and high-risk allowed changes wait for explicit approval before publication.

## Startup and shutdown

```mermaid
sequenceDiagram
    participant App
    participant SEIM
    participant Storage
    participant Workers
    participant Events

    App->>SEIM: seim(config)
    SEIM->>SEIM: Merge and validate configuration
    SEIM->>Storage: Select memory, file, or Redis adapter
    SEIM->>Storage: Load known route states asynchronously
    SEIM->>Workers: Start enabled optimization, drift, issue, and orchestration loops
    SEIM->>Events: Emit lifecycle started
    App->>SEIM: shutdown()
    SEIM->>Workers: Stop workers, timers, trackers, and orchestrator
    SEIM->>Storage: Close Redis connection when present
    SEIM->>Events: Emit shutdown and remove listeners
```

Applications should always await `shutdown()` during graceful termination. Construction currently starts enabled workers immediately; there is no separate public `start()` phase.

## Failure containment

```mermaid
flowchart TD
    Failure["Candidate, verification, CI, deployment, or runtime failure"] --> Kind{"Failure kind"}
    Kind -->|Runtime candidate| Reject["Reject candidate or roll back active canary"]
    Kind -->|Workspace verification| JobFail["Reject job with check evidence"]
    Kind -->|Transient GitHub workflow| Retry["One failed-job retry if SHA is current"]
    Kind -->|Repeated GitHub failure| Circuit["Open fingerprint circuit breaker"]
    Kind -->|Deployment| Provider["Provider workflow fails; protected manual rollback remains"]
    Reject --> Evidence["Events, state, and changelog"]
    JobFail --> Evidence
    Retry --> Evidence
    Circuit --> Evidence
    Provider --> Evidence
```

## Current implementation boundary

SEIM currently provides a tested foundation for taking over a baseline React/Next plus Node repository through bounded goals, verified pull requests, protected GitHub delivery, and a repair feedback loop. It does not yet prove unattended operation for arbitrary applications or all change categories.

The most important remaining production validations are:

- live integration tests against an actual Redis service and a multi-process deployment;
- live GitHub App, protected-branch, webhook, Vercel, AWS OIDC/ECR/ECS, and rollback drills;
- an externally isolated engineer worker for executing repository commands;
- project-specific browser, integration, security, migration, and acceptance tests;
- central persistence for runtime metrics, candidates, artifacts, learning, and changelog when running multiple replicas;
- broader planners for data migrations, authentication, billing, operations, and arbitrary cross-cutting refactors.

Those are explicit operational boundaries, not hidden fallbacks. SEIM's safety model is to stop, reject, or request approval when its current planner or verification contract cannot establish a safe change.
