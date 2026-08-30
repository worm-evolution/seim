import * as fs from 'fs';
import * as path from 'path';
import type { ProjectManifest, ApplicationHandoffContract } from './types';
import { validateDeliveryTargets } from '../delivery/validation';

export const HANDOFF_FILE = '.seim/handoff.json';

export function loadHandoffContract(rootDir: string): ApplicationHandoffContract | undefined {
  const filePath = path.join(rootDir, HANDOFF_FILE);
  if (!fs.existsSync(filePath)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) { throw new Error(`Invalid ${HANDOFF_FILE}: ${error instanceof Error ? error.message : String(error)}`); }
  return validateHandoffContract(parsed);
}

export function validateHandoffContract(value: unknown): ApplicationHandoffContract {
  if (!value || typeof value !== 'object') throw new Error(`${HANDOFF_FILE} must contain a JSON object`);
  const input = value as Record<string, any>;
  if (input.version !== 1) throw new Error(`${HANDOFF_FILE} version must be 1`);
  if (!input.application || typeof input.application.name !== 'string' || !input.application.name.trim()) {
    throw new Error(`${HANDOFF_FILE} application.name is required`);
  }
  const autonomy = input.policies?.autonomy || 'pull_request';
  if (!['observe', 'plan', 'pull_request', 'merge', 'deploy'].includes(autonomy)) {
    throw new Error(`${HANDOFF_FILE} policies.autonomy is invalid`);
  }
  const protectedPaths = stringArray(input.policies?.protectedPaths, 'policies.protectedPaths');
  const approvalRequiredPaths = stringArray(input.policies?.approvalRequiredPaths, 'policies.approvalRequiredPaths');
  for (const candidate of [...protectedPaths, ...approvalRequiredPaths]) assertRelativePolicyPath(candidate);
  const commands = input.commands || {};
  const deliveryTargets = validateDeliveryTargets(input.delivery?.targets);
  for (const [name, command] of Object.entries(commands)) {
    if (!['typecheck', 'test', 'integration', 'build', 'browser'].includes(name) || (command !== undefined && typeof command !== 'string')) {
      throw new Error(`${HANDOFF_FILE} contains an invalid command: ${name}`);
    }
  }
  return {
    version: 1,
    application: { name: input.application.name.trim(), owner: optionalString(input.application.owner) },
    repository: { baseBranch: optionalString(input.repository?.baseBranch) || 'main' },
    paths: {
      frontend: optionalString(input.paths?.frontend),
      backend: optionalString(input.paths?.backend),
      tests: optionalString(input.paths?.tests),
      designSystem: optionalString(input.paths?.designSystem),
      database: optionalString(input.paths?.database),
    },
    commands: { ...commands },
    delivery: input.delivery ? { targets: deliveryTargets } : undefined,
    policies: {
      autonomy,
      protectedPaths,
      approvalRequiredPaths,
      requireTests: input.policies?.requireTests !== false,
      requireBrowserForFrontend: input.policies?.requireBrowserForFrontend !== false,
    },
  };
}

export function createHandoffContract(manifest: ProjectManifest): ApplicationHandoffContract {
  return {
    version: 1,
    application: { name: manifest.packageName || path.basename(manifest.rootDir) },
    repository: { baseBranch: manifest.baseBranch },
    paths: {
      frontend: manifest.frontendContext.appDirectory || manifest.frontendContext.pagesDirectory || (manifest.frontendEntrypoint ? path.dirname(manifest.frontendEntrypoint) : undefined),
      backend: manifest.backendEntrypoint ? path.dirname(manifest.backendEntrypoint) || '.' : undefined,
      tests: manifest.contextIndex.testFiles.length > 0 ? commonRoot(manifest.contextIndex.testFiles) : undefined,
      designSystem: manifest.contextIndex.designSystemFiles.length > 0 ? commonRoot(manifest.contextIndex.designSystemFiles) : undefined,
      database: manifest.contextIndex.databaseFiles.length > 0 ? commonRoot(manifest.contextIndex.databaseFiles) : undefined,
    },
    commands: { ...manifest.commands },
    delivery: { targets: [] },
    policies: {
      autonomy: 'pull_request',
      protectedPaths: ['.env', '.git', 'secrets'],
      approvalRequiredPaths: ['.github', 'infra', 'migrations', 'prisma', 'package.json', 'package-lock.json'],
      requireTests: true,
      requireBrowserForFrontend: true,
    },
  };
}

export async function writeHandoffContract(rootDir: string, contract: ApplicationHandoffContract, overwrite = false): Promise<string> {
  const validated = validateHandoffContract(contract);
  const filePath = path.join(path.resolve(rootDir), HANDOFF_FILE);
  if (!overwrite && fs.existsSync(filePath)) throw new Error(`${HANDOFF_FILE} already exists; use --force to replace it`);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(temporaryPath, filePath);
  return filePath;
}

export function pathMatchesPolicy(filePath: string, policyPath: string): boolean {
  const file = normalize(filePath);
  const policy = normalize(policyPath).replace(/\/$/, '');
  return file === policy || file.startsWith(`${policy}/`);
}

function normalize(value: string): string { return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, ''); }
function optionalString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${HANDOFF_FILE} ${field} must be a string array`);
  return Array.from(new Set(value.map(item => item.trim()).filter(Boolean)));
}
function assertRelativePolicyPath(value: string): void {
  const normalized = normalize(value);
  if (!normalized || path.isAbsolute(value) || normalized.split('/').includes('..')) throw new Error(`${HANDOFF_FILE} policy paths must stay inside the repository: ${value}`);
}
function commonRoot(files: string[]): string {
  const segments = files.map(file => normalize(file).split('/'));
  const first = segments[0] || [];
  let index = 0;
  while (index < first.length - 1 && segments.every(parts => parts[index] === first[index])) index++;
  return first.slice(0, index).join('/') || '.';
}
