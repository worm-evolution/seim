import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { FeatureScaffolder } from '../scaffolder';
import { ProductIssue } from '../issueStream';
import { ReactComponentGenerator } from '../react/componentGenerator';
import { ChangeFile, ChangePlan, ProjectManifest } from './types';
import type { CiRepairPlanner } from './ciRepairPlanner';

export class IssuePlanner {
  constructor(
    private scaffolder: FeatureScaffolder,
    private reactGenerator: ReactComponentGenerator,
    private ciRepairPlanner?: CiRepairPlanner,
  ) {}

  public async create(issue: ProductIssue, manifest: ProjectManifest): Promise<ChangePlan> {
    if (issue.type === 'feature:missing_api') return this.backendFeature(issue, manifest);
    if (issue.type === 'feature:missing_page' || issue.type.startsWith('ux:')) return this.frontendFeature(issue, manifest);
    if (issue.type === 'bug:error_pattern' && issue.intentMetadata?.source === 'github-feedback') {
      if (!this.ciRepairPlanner) throw new Error('No CI repair planner is configured');
      return this.ciRepairPlanner.create(issue, manifest);
    }
    throw new Error(`No safe repository planner is configured for issue type ${issue.type}`);
  }

  private async backendFeature(issue: ProductIssue, manifest: ProjectManifest): Promise<ChangePlan> {
    if (!manifest.backendEntrypoint) throw new Error('Cannot safely add an API route: backend entrypoint was not detected');
    const entrypoint = path.join(manifest.rootDir, manifest.backendEntrypoint);
    const original = await fs.promises.readFile(entrypoint, 'utf8');
    if (!/\bapp\s*\./.test(original)) throw new Error('Cannot safely add an API route: Express app variable was not detected');

    const method = (issue.method || 'GET').toLowerCase();
    const name = safeName(`${method}-${issue.path}`);
    const extension = /\.tsx?$/.test(manifest.backendEntrypoint) ? 'ts' : 'js';
    const generatedPath = `src/seim-generated/${name}.${extension}`;
    const modulePath = relativeModulePath(manifest.backendEntrypoint, generatedPath);
    const identifier = `seimGenerated_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const generated = await this.scaffolder.scaffoldRoute(method, issue.path, issue.suggestedAction);
    const moduleCode = extension === 'ts'
      ? normalizeHandler(generated, 'export default async function handler')
      : normalizeHandler(generated, 'module.exports = async function handler');
    const registration = extension === 'ts'
      ? `import ${identifier} from ${JSON.stringify(modulePath)};\napp.${method}(${JSON.stringify(issue.path)}, ${identifier});`
      : `const ${identifier} = require(${JSON.stringify(modulePath)});\napp.${method}(${JSON.stringify(issue.path)}, ${identifier});`;
    const updated = `${original.trimEnd()}\n\n// SEIM generated route: ${issue.id}\n${registration}\n`;

    return this.plan(`feat(${name}): add ${method.toUpperCase()} ${issue.path}`, `Implement the requested API route from ${issue.affectedSessions} visitor sessions.`, issue, [
      { path: generatedPath, operation: 'create', content: moduleCode },
      { path: manifest.backendEntrypoint, operation: 'update', content: updated, expectedSha256: sha256(original) },
    ], 'medium');
  }

  private async frontendFeature(issue: ProductIssue, manifest: ProjectManifest): Promise<ChangePlan> {
    if (manifest.frontendContext.router === "next-app") return this.nextFileFeature(issue, manifest, manifest.frontendContext.appDirectory || "app", "Next.js app-router");
    if (manifest.frontendContext.router === "next-pages") return this.nextFileFeature(issue, manifest, manifest.frontendContext.pagesDirectory || "pages", "Next.js pages-router");
    const entrypoint = manifest.frontendRoutesFile || manifest.frontendEntrypoint;
    if (!entrypoint) throw new Error('Cannot safely add a React page: frontend entrypoint was not detected');
    const absoluteEntrypoint = path.join(manifest.rootDir, entrypoint);
    const original = await fs.promises.readFile(absoluteEntrypoint, 'utf8');
    if (!/<Routes\b/.test(original) || !/<\/Routes>/.test(original) || !/\bRoute\b/.test(original)) {
      throw new Error('Cannot safely add a React page: a <Routes> block was not detected');
    }

    const componentName = `${safeName(issue.path).split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('') || 'Evolved'}Page`;
    const component = await this.reactGenerator.generate({
      name: componentName,
      routePath: issue.path,
      intent: issue.suggestedAction,
      applicationContext: manifest.frontendContext,
      isPage: true,
    });
    const componentPath = `src/seim-generated/${componentName}.tsx`;
    const importPath = relativeModulePath(entrypoint, componentPath);
    const importLine = `import ${componentName} from ${JSON.stringify(importPath)};`;
    const routeLine = `<Route path=${JSON.stringify(issue.path)} element={<${componentName} />} />`;
    const updated = `${importLine}\n${original.replace(/<\/Routes>/, `      ${routeLine}\n    </Routes>`)}`;

    return this.plan(`feat(${componentName}): add ${issue.path} page`, `Implement the requested React page and register it in the existing router.`, issue, [
      { path: componentPath, operation: 'create', content: component.code },
      { path: entrypoint, operation: 'update', content: updated, expectedSha256: sha256(original) },
    ], 'medium');
  }

  private async nextFileFeature(issue: ProductIssue, manifest: ProjectManifest, directory: string, routerName: string): Promise<ChangePlan> {
    const routeSegments = issue.path.split("?")[0].split("/").filter(Boolean);
    const unsafe = routeSegments.some(segment => segment === "." || segment === ".." || !segment || /[^a-zA-Z0-9_-]/.test(segment));
    if (unsafe) throw new Error("Cannot safely add a Next page: route contains unsafe path segments");

    const componentName = safeName(issue.path).split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("") + "Page";
    const component = await this.reactGenerator.generate({
      name: componentName,
      routePath: issue.path,
      intent: issue.suggestedAction,
      isPage: true,
      applicationContext: manifest.frontendContext,
    });
    const generatedPath = directory + "/" + (routeSegments.join("/") || (routerName.includes("app-router") ? "home" : "index")) + (routerName.includes("app-router") ? "/page.tsx" : ".tsx");
    return this.plan("feat(" + componentName + "): add " + issue.path + " page", "Implement the requested Next page from " + issue.affectedSessions + " visitor sessions.", issue, [
      { path: generatedPath, operation: "create", content: component.code },
    ], "medium");
  }

  private plan(title: string, summary: string, issue: ProductIssue, files: ChangeFile[], risk: ChangePlan['risk']): ChangePlan {
    return {
      id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      title,
      summary,
      issueId: issue.id,
      files,
      risk,
      reasons: [`Triggered by ${issue.frequency} observations across ${issue.affectedSessions} sessions`],
      generatedBy: 'template',
      createdAt: Date.now(),
    };
  }
}

function normalizeHandler(code: string, declaration: string): string {
  const clean = code.replace(/^```(?:javascript|typescript|js|ts)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (/async\s+function\s+handler\s*\(/.test(clean)) {
    return clean.replace(/async\s+function\s+handler\s*\(/, `${declaration}(`);
  }
  return `${declaration}(req, res) {\n${clean}\n}\n`;
}

function relativeModulePath(fromFile: string, toFile: string): string {
  const value = path.relative(path.dirname(fromFile), toFile).replace(/\\/g, '/').replace(/\.[^.\/]+$/, '');
  return value.startsWith('.') ? value : `./${value}`;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'generated';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
