import * as path from 'path';
import type { DeliveryTarget } from '../engineer/types';

export function validateDeliveryTargets(value: unknown): DeliveryTarget[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('handoff delivery.targets must be an array');
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') throw new Error(`delivery target ${index} must be an object`);
    const input = candidate as Record<string, unknown>;
    const id = requiredIdentifier(input.id, `delivery target ${index}.id`);
    if (ids.has(id)) throw new Error(`duplicate delivery target id: ${id}`);
    ids.add(id);
    if (input.provider !== 'vercel' && input.provider !== 'aws-ecs') throw new Error(`delivery target ${id} has an unsupported provider`);
    const workingDirectory = relativePath(input.workingDirectory, `delivery target ${id}.workingDirectory`);
    const productionBranch = safeBranch(input.productionBranch, `delivery target .productionBranch`);
    const healthCheckUrl = optionalHttpsUrl(input.healthCheckUrl, `delivery target ${id}.healthCheckUrl`);
    if (input.provider === 'vercel') return { id, provider: 'vercel', workingDirectory, productionBranch, healthCheckUrl };
    return {
      id,
      provider: 'aws-ecs',
      workingDirectory,
      productionBranch,
      healthCheckUrl,
      taskDefinition: relativePath(input.taskDefinition, `delivery target ${id}.taskDefinition`) || '.aws/task-definition.json',
      containerName: requiredIdentifier(input.containerName || 'app', `delivery target ${id}.containerName`),
    };
  });
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(value)) throw new Error(`${field} must be a safe identifier`);
  return value;
}
function optionalString(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function safeBranch(value: unknown, field: string): string | undefined {
  const candidate = optionalString(value);
  if (!candidate) return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(candidate) || candidate.includes("..") || candidate.endsWith("/")) throw new Error(`${field} must be a safe Git branch`);
  return candidate;
}
function relativePath(value: unknown, field: string): string | undefined {
  const candidate = optionalString(value);
  if (!candidate) return undefined;
  if (path.isAbsolute(candidate) || candidate.replace(/\\/g, '/').split('/').includes('..')) throw new Error(`${field} must stay inside the repository`);
  return candidate.replace(/\\/g, '/').replace(/^\.\//, '');
}
function optionalHttpsUrl(value: unknown, field: string): string | undefined {
  const candidate = optionalString(value);
  if (!candidate) return undefined;
  let url: URL;
  try { url = new URL(candidate); } catch { throw new Error(`${field} must be a valid URL`); }
  if (url.protocol !== 'https:') throw new Error(`${field} must use HTTPS`);
  return url.toString().replace(/\/$/, '');
}
