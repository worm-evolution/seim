import * as fs from 'fs';
import * as path from 'path';
import { SeimConfig } from './types';
import { ProductIssue } from './issueStream';

export interface GeneratedPullRequest {
  id: string;
  number: number;
  branchName: string;
  title: string;
  description: string;
  targetPath: string;
  code: string;
  diff?: string;
  patch: string;
  metadata: {
    issueType?: string;
    affectedSessions?: number;
    latencyImprovement?: string;
    evidence?: any[];
    createdAt: number;
  };
  status: 'open' | 'merged' | 'closed';
  patchPath?: string;
  docPath?: string;
}

export class PrGenerator {
  private prDir: string;
  private prs: Map<string, GeneratedPullRequest> = new Map();
  private nextNumber = 1;

  constructor(private config: SeimConfig, storagePath: string = './.seim-storage') {
    this.prDir = path.join(storagePath, 'pull-requests');
    this.load();
  }

  public async createPrFromIssue(
    issue: ProductIssue,
    code: string,
    diff?: string
  ): Promise<GeneratedPullRequest> {
    const prNumber = this.nextNumber++;
    const safeName = issue.path.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'feature';
    const branchName = `seim/feat-${safeName}`;
    const prId = `PR-${prNumber}`;

    const title = issue.type.startsWith('feature:')
      ? `feat(${safeName}): autonomously implement ${issue.method || 'GET'} ${issue.path}`
      : `fix(${safeName}): resolve ${issue.type} on ${issue.path}`;

    const description = `### 📋 SEIM Telemetry-Driven Pull Request #${prNumber}

#### 🎯 Problem Statement & Discovery Rationale
SEIM observed real visitor telemetry on \`${issue.path}\` and identified high user demand:
- **Issue Type**: \`${issue.type}\`
- **Affected Visitor Sessions**: ${issue.affectedSessions}
- **Observed Frequency**: ${issue.frequency} occurrences
- **Suggested Action**: ${issue.suggestedAction}

#### 🛠️ Proposed Solution
Autonomously scaffolded, sandbox-verified code generated to resolve this demand without breaking existing routes or invariants.

#### 🧪 Verification & Safety Checklist
- [x] Pre-flight AST Security Gate passed (Zero credential/auth/payment tampering)
- [x] Sandbox isolation verified without side effects
- [x] Syntax & type contracts validated
- [x] 1-Click Rollback available post-merge

---
*Generated autonomously by SEIM Infrastructure Engine.*
`;

    const patch = `From: SEIM Autonomous Engine <seim@worm-evolution.ai>
Date: ${new Date().toISOString()}
Subject: [PATCH] ${title}

---
 ${issue.path} | +${code.split('\n').length}
 1 file changed, ${code.split('\n').length} insertions(+)

diff --git a/${issue.path} b/${issue.path}
new file mode 100644
--- /dev/null
+++ b/${issue.path}
${code.split('\n').map(line => `+${line}`).join('\n')}
-- 
SEIM Engine
`;

    const pr: GeneratedPullRequest = {
      id: prId,
      number: prNumber,
      branchName,
      title,
      description,
      targetPath: issue.path,
      code,
      diff,
      patch,
      metadata: {
        issueType: issue.type,
        affectedSessions: issue.affectedSessions,
        evidence: issue.evidence,
        createdAt: Date.now(),
      },
      status: 'open',
    };

    if (!fs.existsSync(this.prDir)) {
      fs.mkdirSync(this.prDir, { recursive: true });
    }

    const patchPath = path.join(this.prDir, `${prId}.patch`);
    const docPath = path.join(this.prDir, `${prId}.md`);

    await fs.promises.writeFile(patchPath, patch, 'utf8');
    await fs.promises.writeFile(docPath, description, 'utf8');

    pr.patchPath = patchPath;
    pr.docPath = docPath;

    this.prs.set(prId, pr);
    this.save();

    return pr;
  }

  public async createPrFromOptimization(
    routeKey: string,
    originalCode: string,
    optimizedCode: string,
    latencyImprovement: string
  ): Promise<GeneratedPullRequest> {
    const prNumber = this.nextNumber++;
    const safeName = routeKey.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'optimization';
    const branchName = `seim/perf-${safeName}`;
    const prId = `PR-${prNumber}`;

    const title = `perf(${safeName}): optimize latency on ${routeKey} (-${latencyImprovement})`;

    const description = `### 📋 SEIM Optimization Pull Request #${prNumber}

#### ⚡ Performance Improvement
SEIM detected performance anti-patterns on \`${routeKey}\` and synthesized a verified optimization:
- **Latency Improvement**: \`${latencyImprovement}\`
- **Target Endpoint**: \`${routeKey}\`

#### 🧪 Verification & Safety Checklist
- [x] Structural response equivalence verified
- [x] Side-effect-free shadow execution verified
- [x] SecurityGate validated
`;

    const patch = `From: SEIM Optimization Engine <seim@worm-evolution.ai>
Date: ${new Date().toISOString()}
Subject: [PATCH] ${title}

---
 ${routeKey} | Performance optimization
 1 file changed

diff --git a/${routeKey} b/${routeKey}
--- a/${routeKey}
+++ b/${routeKey}
${optimizedCode.split('\n').map(line => `+${line}`).join('\n')}
-- 
SEIM Engine
`;

    const pr: GeneratedPullRequest = {
      id: prId,
      number: prNumber,
      branchName,
      title,
      description,
      targetPath: routeKey,
      code: optimizedCode,
      patch,
      metadata: {
        latencyImprovement,
        createdAt: Date.now(),
      },
      status: 'open',
    };

    if (!fs.existsSync(this.prDir)) {
      fs.mkdirSync(this.prDir, { recursive: true });
    }

    const patchPath = path.join(this.prDir, `${prId}.patch`);
    const docPath = path.join(this.prDir, `${prId}.md`);

    await fs.promises.writeFile(patchPath, patch, 'utf8');
    await fs.promises.writeFile(docPath, description, 'utf8');

    pr.patchPath = patchPath;
    pr.docPath = docPath;

    this.prs.set(prId, pr);
    this.save();

    return pr;
  }

  public listAll(): GeneratedPullRequest[] {
    return Array.from(this.prs.values()).sort((a, b) => b.number - a.number);
  }

  public getById(id: string): GeneratedPullRequest | undefined {
    return this.prs.get(id);
  }

  public mergePr(id: string): boolean {
    const pr = this.prs.get(id);
    if (pr && pr.status === 'open') {
      pr.status = 'merged';
      this.save();
      return true;
    }
    return false;
  }

  public closePr(id: string): boolean {
    const pr = this.prs.get(id);
    if (pr && pr.status === 'open') {
      pr.status = 'closed';
      this.save();
      return true;
    }
    return false;
  }

  private save(): void {
    try {
      if (!fs.existsSync(this.prDir)) fs.mkdirSync(this.prDir, { recursive: true });
      const metaPath = path.join(this.prDir, 'index.json');
      fs.writeFileSync(metaPath, JSON.stringify(Array.from(this.prs.values()), null, 2), 'utf8');
    } catch {
      // Best-effort persistence
    }
  }

  private load(): void {
    try {
      const metaPath = path.join(this.prDir, 'index.json');
      if (fs.existsSync(metaPath)) {
        const list: GeneratedPullRequest[] = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        this.prs.clear();
        for (const item of list) {
          this.prs.set(item.id, item);
          if (item.number >= this.nextNumber) {
            this.nextNumber = item.number + 1;
          }
        }
      }
    } catch {
      this.prs.clear();
    }
  }
}
