import { exec } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { LLMClient } from '../ai';
import type { ProductIssue } from '../issueStream';
import type { ChangeFile, ChangePlan, ProjectManifest } from './types';

const execAsync = promisify(exec);

export interface RepairModel { chat(system: string, user: string): Promise<string>; }

export class CiRepairPlanner {
  constructor(private model: RepairModel, private enabled: boolean, private diagnosticTimeoutMs = 2 * 60 * 1000) {}

  public async create(issue: ProductIssue, manifest: ProjectManifest): Promise<ChangePlan> {
    if (!this.enabled) throw new Error('CI repair requires an enabled AI provider and API key');
    const diagnostics = await this.reproduce(manifest, issue);
    const context = await this.repositoryContext(manifest, diagnostics);
    const response = await this.model.chat(SYSTEM_PROMPT, JSON.stringify({
      failure: { path: issue.path, action: issue.suggestedAction, evidence: sanitizeEvidence(issue.evidence) },
      application: {
        packageName: manifest.packageName,
        packageManager: manifest.packageManager,
        frontend: manifest.frontendContext,
        backendEntrypoint: manifest.backendEntrypoint,
        commands: manifest.commands,
      },
      diagnostics,
      files: context,
    }));
    const proposed = parseProposal(response);
    const files = await this.validateChanges(manifest, proposed.changes);
    return {
      id: `repair_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      title: proposed.title.slice(0, 120),
      summary: proposed.summary.slice(0, 1000),
      issueId: issue.id,
      files,
      risk: 'low',
      reasons: ['GitHub reported a failed SEIM delivery check', 'A bounded diagnostic reproduction was supplied to the repair model', 'The proposed patch must pass the complete repository verification policy'],
      generatedBy: 'model',
      createdAt: Date.now(),
    };
  }

  private async reproduce(manifest: ProjectManifest, issue: ProductIssue): Promise<Array<{ name: string; command: string; passed: boolean; output: string }>> {
    const checks = selectChecks(manifest, issue).slice(0, 2);
    if (checks.length === 0) return [];
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'seim-diagnostic-'));
    try {
      await fs.promises.cp(manifest.rootDir, workspace, { recursive: true, force: true, filter: source => !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}.git`) });
      const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(key)));
      const results: Array<{ name: string; command: string; passed: boolean; output: string }> = [];
      for (const [name, command] of checks) {
        try {
          const result = await execAsync(command, { cwd: workspace, timeout: this.diagnosticTimeoutMs, maxBuffer: 2 * 1024 * 1024, env: { ...safeEnv, CI: '1', NODE_ENV: 'test', SEIM_ENGINEER_WORKER: '1' } });
          results.push({ name, command, passed: true, output: redact(`${result.stdout}\n${result.stderr}`).slice(-12000) });
        } catch (error: any) {
          results.push({ name, command, passed: false, output: redact(`${error?.stdout || ''}\n${error?.stderr || error?.message || error}`).slice(-12000) });
        }
      }
      return results;
    } finally {
      await fs.promises.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async repositoryContext(manifest: ProjectManifest, diagnostics: Array<{ output: string }>): Promise<Array<{ path: string; content: string }>> {
    const mentioned = new Set<string>();
    for (const diagnostic of diagnostics) {
      for (const match of diagnostic.output.matchAll(/(?:^|[\s("'])([a-zA-Z0-9_.@/-]+\.(?:tsx?|jsx?|json|ya?ml|css|scss|mjs|cjs))(?:[:\s)"']|$)/gm)) mentioned.add(match[1].replace(/^\.\//, ''));
    }
    const index = manifest.contextIndex;
    const candidates = [
      ...mentioned,
      ...(manifest.backendEntrypoint ? [manifest.backendEntrypoint] : []),
      ...(manifest.frontendEntrypoint ? [manifest.frontendEntrypoint] : []),
      ...index.configurationFiles,
      ...index.deploymentFiles,
      ...index.testFiles,
      ...index.sourceFiles,
    ];
    const result: Array<{ path: string; content: string }> = [];
    const seen = new Set<string>();
    let total = 0;
    for (const relative of candidates) {
      if (seen.has(relative) || sensitivePath(relative) || result.length >= 40 || total >= 180000) continue;
      seen.add(relative);
      let absolute: string;
      try { absolute = assertInside(manifest.rootDir, relative); } catch { continue; }
      try {
        const stat = await fs.promises.stat(absolute);
        if (!stat.isFile() || stat.size > 40000) continue;
        const content = await fs.promises.readFile(absolute, 'utf8');
        if (content.includes('\0')) continue;
        const safe = redact(content);
        if (total + safe.length > 180000) continue;
        total += safe.length;
        result.push({ path: relative.replace(/\\/g, '/'), content: safe });
      } catch { /* file disappeared after indexing */ }
    }
    return result;
  }

  private async validateChanges(manifest: ProjectManifest, changes: unknown): Promise<ChangeFile[]> {
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 8) throw new Error('Repair model must propose between 1 and 8 file changes');
    const result: ChangeFile[] = [];
    let total = 0;
    const paths = new Set<string>();
    for (const candidate of changes) {
      if (!candidate || typeof candidate !== 'object') throw new Error('Repair model returned an invalid change');
      const change = candidate as any;
      const relative = String(change.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
      const operation = change.operation;
      if (!relative || sensitivePath(relative) || paths.has(relative)) throw new Error(`Repair model returned an unsafe or duplicate path: ${relative || '<empty>'}`);
      if (!['create', 'update', 'delete'].includes(operation)) throw new Error(`Repair model returned an invalid operation for ${relative}`);
      if (/^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(relative)) throw new Error('Repair model cannot synthesize package-manager lockfiles');
      paths.add(relative);
      const absolute = assertInside(manifest.rootDir, relative);
      const exists = await fs.promises.stat(absolute).then(stat => stat.isFile()).catch(() => false);
      if (operation === 'create' && exists) throw new Error(`Repair create target already exists: ${relative}`);
      if (operation !== 'create' && !exists) throw new Error(`Repair target does not exist: ${relative}`);
      if (operation === 'delete') {
        const original = await fs.promises.readFile(absolute);
        result.push({ path: relative, operation, expectedSha256: sha256(original) });
        continue;
      }
      if (typeof change.content !== 'string' || change.content.length > 50000) throw new Error(`Repair content is missing or too large: ${relative}`);
      total += change.content.length;
      if (total > 200000) throw new Error('Repair patch exceeds the 200KB safety limit');
      result.push({ path: relative, operation, content: change.content, expectedSha256: exists ? sha256(await fs.promises.readFile(absolute)) : undefined });
    }
    return result;
  }
}

const SYSTEM_PROMPT = `You are SEIM's production repair planner. Diagnose the supplied CI or deployment failure using only the bounded repository context and reproduced command output. Return strict JSON with this shape: {"title":"fix(...): ...","summary":"...","changes":[{"path":"relative/path","operation":"create|update|delete","content":"complete file content for create/update"}]}. Make the smallest root-cause fix. Preserve public behavior, tests, authentication, authorization, billing, secrets, deployment approvals, and branch protections. Never weaken tests, delete failing tests, expose credentials, add generated lockfiles, modify .env files, or bypass a failing check. Do not use markdown.`;

function selectChecks(manifest: ProjectManifest, issue: ProductIssue): Array<[string, string]> {
  const text = JSON.stringify(issue.evidence).toLowerCase();
  const available = Object.entries(manifest.commands).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1]);
  const matched = available.filter(([name]) => text.includes(name) || (name === 'typecheck' && text.includes('type')));
  return matched.length ? matched : available.filter(([name]) => ['typecheck', 'test', 'build'].includes(name));
}
function parseProposal(value: string): { title: string; summary: string; changes: unknown } {
  const match = value.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Repair model did not return JSON');
  let parsed: any;
  try { parsed = JSON.parse(match[0]); } catch { throw new Error('Repair model returned invalid JSON'); }
  if (typeof parsed.title !== 'string' || typeof parsed.summary !== 'string') throw new Error('Repair model omitted title or summary');
  return parsed;
}
function assertInside(root: string, relative: string): string {
  if (!relative || relative.split('/').includes('..')) throw new Error(`Unsafe repair path: ${relative}`);
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(resolvedRoot, relative);
  if (absolute !== resolvedRoot && !absolute.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Repair path escaped repository: ${relative}`);
  return absolute;
}
function sensitivePath(value: string): boolean { return /(^|\/)(\.env(?:\.|$)|\.git|node_modules|dist|build|coverage)(\/|$)|\.(pem|key|p12|pfx)$/i.test(value); }
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function redact(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s'";]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password|private[_-]?key)\s*[:=]\s*)[^\s'";,]+/gi, '$1[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]');
}
function sanitizeEvidence(evidence: any[]): any[] {
  const sanitized = redact(JSON.stringify(evidence));
  if (sanitized.length > 30000) return [{ truncated: true, content: sanitized.slice(0, 30000) }];
  try { return JSON.parse(sanitized); } catch { return [{ content: sanitized.slice(0, 30000) }]; }
}

export function createCiRepairPlanner(client: LLMClient, enabled: boolean): CiRepairPlanner { return new CiRepairPlanner(client, enabled); }
