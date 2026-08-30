import * as fs from 'fs';
import * as path from 'path';
import { ProjectCommands, ProjectContextIndex, ProjectManifest } from './types';
import type { ReactApplicationContext } from '../react/types';
import { loadHandoffContract } from './handoff';

interface PackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.cache', '.turbo', 'vendor', 'tmp', 'temp']);
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|vue|svelte)$/i;

export class ProjectAdapter {
  public inspect(rootDir: string, overrides: Partial<ProjectManifest> = {}): ProjectManifest {
    const resolvedRoot = path.resolve(rootDir);
    const packageJson = this.readPackageJson(resolvedRoot);
    const handoff = loadHandoffContract(resolvedRoot);
    const scripts = packageJson.scripts || {};
    const dependencies = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
    const topLevelFiles = this.listTopLevelFiles(resolvedRoot);
    const contextIndex = this.indexRepository(resolvedRoot);
    const frontend = Boolean(handoff?.paths.frontend || dependencies.react || dependencies.next || dependencies.vite || contextIndex.sourceFiles.some(file => /\.(tsx|jsx)$/.test(file)));
    const backend = Boolean(handoff?.paths.backend || dependencies.express || dependencies.fastify || topLevelFiles.some(file => /(?:server|app|index)\.(ts|js)$/.test(file)));
    const frontendEntrypoint = this.findEntrypoint(resolvedRoot, ['src/App.tsx', 'src/App.jsx', 'app/page.tsx', 'src/app/page.tsx', 'pages/_app.tsx', 'src/pages/_app.tsx']);
    const frontendRoutesFile = this.findEntrypoint(resolvedRoot, ['src/routes.tsx', 'src/AppRoutes.tsx', 'src/router.tsx']);
    const detectedCommands: ProjectCommands = {
      typecheck: scripts.typecheck || (fs.existsSync(path.join(resolvedRoot, 'tsconfig.json')) ? 'tsc --noEmit' : undefined),
      test: scripts.test,
      integration: scripts.integration || scripts['test:integration'],
      build: scripts.build,
      browser: scripts.e2e || scripts.browser || scripts['test:e2e'],
    };
    const commands = { ...detectedCommands, ...(handoff?.commands || {}), ...(overrides.commands || {}) };
    const detectedBaseBranch = handoff?.repository.baseBranch || this.detectBaseBranch(resolvedRoot);

    return {
      version: 1,
      rootDir: resolvedRoot,
      packageManager: this.detectPackageManager(resolvedRoot, packageJson),
      packageName: handoff?.application.name || packageJson.name,
      baseBranch: detectedBaseBranch,
      backendEntrypoint: this.findEntrypoint(resolvedRoot, ['server.ts', 'server.js', 'src/server.ts', 'src/server.js', 'src/app.ts', 'src/app.js', 'app.ts', 'app.js']),
      frontendEntrypoint,
      frontendRoutesFile,
      frontendContext: this.detectFrontendContext(resolvedRoot, packageJson, frontendEntrypoint, frontendRoutesFile),
      frontend,
      backend,
      ...overrides,
      commands,
      contextIndex: overrides.contextIndex || contextIndex,
      handoff: overrides.handoff || handoff,
    };
  }

  public assertSafePath(rootDir: string, filePath: string): string {
    const root = path.resolve(rootDir);
    const resolved = path.resolve(root, filePath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Engineer refused path outside project root: ${filePath}`);
    return resolved;
  }

  private indexRepository(rootDir: string, maximumFiles = 5000): ProjectContextIndex {
    const stack = [''];
    const files: string[] = [];
    let seen = 0;
    let truncated = false;
    while (stack.length > 0) {
      const relativeDirectory = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(path.join(rootDir, relativeDirectory), { withFileTypes: true }); }
      catch { continue; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const relative = path.posix.join(relativeDirectory.replace(/\\/g, '/'), entry.name);
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRECTORIES.has(entry.name)) stack.push(relative);
          continue;
        }
        if (!entry.isFile()) continue;
        seen++;
        if (files.length < maximumFiles) files.push(relative);
        else { truncated = true; break; }
      }
      if (truncated) break;
    }

    const take = (predicate: (file: string) => boolean, limit: number): string[] => files.filter(predicate).slice(0, limit);
    const testPattern = /(^|\/)(test|tests|__tests__|spec|e2e)(\/|$)|\.(?:test|spec)\.[^.]+$/i;
    const documentationPattern = /(^|\/)(docs?|adr)(\/|$)|(^|\/)(README|CONTRIBUTING|ARCHITECTURE|CHANGELOG)(\.[^/]*)?$/i;
    const configPattern = /(^|\/)(\.github|\.seim)(\/|$)|(^|\/)(?:package|tsconfig|vite\.config|next\.config|jest\.config|playwright\.config|docker-compose|Dockerfile|\.env\.example)/i;
    const apiPattern = /(^|\/)(openapi|swagger|graphql|schema|contracts?)(\/|\.|$)|\.(?:graphql|gql)$/i;
    const databasePattern = /(^|\/)(prisma|migrations?|database|db|supabase)(\/|$)|(?:schema\.prisma|drizzle\.config)/i;
    const deploymentPattern = /(^|\/)(\.github\/workflows|infra|terraform|k8s|helm|deploy)(\/|$)|(^|\/)(Dockerfile|docker-compose|vercel\.json|netlify\.toml)/i;
    const designPattern = /(^|\/)(design-system|components\/ui|ui\/components|stories)(\/|$)|\.stories\.[^.]+$/i;
    const languages: Record<string, number> = {};
    for (const file of files) {
      const language = languageFor(file);
      if (language) languages[language] = (languages[language] || 0) + 1;
    }
    return {
      totalFiles: seen,
      indexedFiles: files.length,
      truncated,
      languages,
      sourceFiles: take(file => SOURCE_EXTENSION.test(file) && !testPattern.test(file), 1000),
      testFiles: take(file => testPattern.test(file), 500),
      documentationFiles: take(file => documentationPattern.test(file), 200),
      configurationFiles: take(file => configPattern.test(file), 300),
      apiContractFiles: take(file => apiPattern.test(file), 200),
      databaseFiles: take(file => databasePattern.test(file), 300),
      deploymentFiles: take(file => deploymentPattern.test(file), 300),
      designSystemFiles: take(file => designPattern.test(file), 300),
      workspacePackages: take(file => file === 'package.json' || file.endsWith('/package.json'), 200),
      generatedAt: Date.now(),
    };
  }

  private readPackageJson(rootDir: string): PackageJson {
    try { return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as PackageJson; }
    catch { return {}; }
  }
  private listTopLevelFiles(rootDir: string): string[] { try { return fs.readdirSync(rootDir); } catch { return []; } }
  private findEntrypoint(rootDir: string, candidates: string[]): string | undefined { return candidates.find(candidate => fs.existsSync(path.join(rootDir, candidate))); }
  private detectPackageManager(rootDir: string, packageJson: PackageJson): ProjectManifest['packageManager'] {
    if (packageJson.packageManager?.startsWith('pnpm') || fs.existsSync(path.join(rootDir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(rootDir, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(rootDir, 'package-lock.json'))) return 'npm';
    return 'unknown';
  }
  private detectBaseBranch(rootDir: string): string {
    try { const match = fs.readFileSync(path.join(rootDir, '.git', 'HEAD'), 'utf8').trim().match(/refs\/heads\/(.+)$/); return match?.[1] || 'main'; }
    catch { return 'main'; }
  }
  private detectFrontendContext(rootDir: string, packageJson: PackageJson, entrypoint?: string, routesFile?: string): ReactApplicationContext {
    const dependencies = Object.keys({ ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) }).sort();
    const has = (name: string): boolean => dependencies.includes(name);
    const framework: ReactApplicationContext['framework'] = has('next') ? 'next' : has('vite') ? 'vite' : has('react') ? 'react' : 'unknown';
    const appDirectory = has('next') ? (fs.existsSync(path.join(rootDir, 'app')) ? 'app' : fs.existsSync(path.join(rootDir, 'src', 'app')) ? 'src/app' : undefined) : undefined;
    const pagesDirectory = has('next') ? (fs.existsSync(path.join(rootDir, 'pages')) ? 'pages' : fs.existsSync(path.join(rootDir, 'src', 'pages')) ? 'src/pages' : undefined) : undefined;
    const router: ReactApplicationContext['router'] = appDirectory ? 'next-app' : pagesDirectory ? 'next-pages' : has('react-router-dom') ? 'react-router' : 'unknown';
    const source = [entrypoint, routesFile].filter((file): file is string => Boolean(file)).map(file => this.readText(path.join(rootDir, file))).join('\n');
    return {
      framework, router, entrypoint, appDirectory, pagesDirectory, routesFile, dependencies,
      stylingLibraries: dependencies.filter(dependency => /tailwind|styled-components|emotion|mui|antd|chakra|bootstrap|sass|less/i.test(dependency)),
      stateLibraries: dependencies.filter(dependency => /redux|zustand|jotai|recoil|mobx|xstate/i.test(dependency)),
      dataLibraries: dependencies.filter(dependency => /query|swr|apollo|urql|axios/i.test(dependency)),
      existingRoutes: Array.from(source.matchAll(/(?:path|href)\s*=\s*["\x27`]([^"\x27`]+)["\x27`]/g)).map(match => match[1]).slice(0, 100),
    };
  }
  private readText(filePath: string): string { try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; } }
}

function languageFor(file: string): string | undefined {
  const extension = path.extname(file).toLowerCase();
  const map: Record<string, string> = { '.ts': 'TypeScript', '.tsx': 'TypeScript React', '.js': 'JavaScript', '.jsx': 'JavaScript React', '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#', '.vue': 'Vue', '.svelte': 'Svelte', '.sql': 'SQL' };
  return map[extension];
}
