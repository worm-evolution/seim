import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { ProjectAdapter } from './projectAdapter';
import { ChangeFile, ProjectManifest, VerificationCheck, VerificationReport } from './types';

const execAsync = promisify(exec);

export class WorkspaceExecutor {
  private readonly adapter = new ProjectAdapter();

  public async verify(manifest: ProjectManifest, files: ChangeFile[], maxVerificationMs = 10 * 60 * 1000): Promise<VerificationReport> {
    const workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'seim-engineer-'));
    const checks: VerificationCheck[] = [];
    try {
      await this.assertNoSymlinks(manifest.rootDir);
      await fs.promises.cp(manifest.rootDir, workspacePath, {
        recursive: true,
        force: true,
        filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}.git`),
      });
      await this.applyChanges(workspacePath, files);

      checks.push(this.staticCheck(files));
      if (!checks[0].passed) return { passed: false, checks, generatedAt: Date.now() };

      if (manifest.handoff?.policies.requireTests && !manifest.commands.test && !manifest.commands.integration) {
        checks.push({ name: 'test-policy', passed: false, skipped: true, durationMs: 0, reason: 'Handoff requires tests but no test or integration command is configured' });
      }

      const commands: Array<[string, string | undefined]> = [
        ['typecheck', manifest.commands.typecheck],
        ['test', manifest.commands.test],
        ['integration', manifest.commands.integration],
        ['build', manifest.commands.build],
      ];
      for (const [name, command] of commands) {
        if (command) checks.push(await this.runCheck(name, command, workspacePath, maxVerificationMs));
      }

      const frontendChanged = files.some(file => /\.(tsx|jsx|css|scss|less)$/.test(file.path));
      if (frontendChanged) {
        if (!manifest.commands.browser) {
          if (manifest.handoff?.policies.requireBrowserForFrontend !== false) checks.push({ name: 'browser', passed: false, skipped: true, durationMs: 0, reason: 'Frontend changes require a configured browser command' });
        } else {
          checks.push(await this.runCheck('browser', manifest.commands.browser, workspacePath, maxVerificationMs));
        }
      }
      return { passed: checks.every(check => check.passed && !check.skipped), checks, generatedAt: Date.now() };
    } finally {
      await fs.promises.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async applyChanges(workspacePath: string, files: ChangeFile[]): Promise<void> {
    for (const file of files) {
      const target = this.adapter.assertSafePath(workspacePath, file.path);
      await this.assertNoSymlinkPath(workspacePath, target);
      if (file.operation === 'delete') {
        await fs.promises.rm(target, { force: true });
        continue;
      }
      if (file.content === undefined) throw new Error(`Change ${file.path} has no content`);
      if (file.operation === 'update' && file.expectedSha256 && fs.existsSync(target)) {
        const current = createHash('sha256').update(await fs.promises.readFile(target)).digest('hex');
        if (current !== file.expectedSha256) throw new Error(`Source changed while planning: ${file.path}`);
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, file.content, 'utf8');
    }
  }

  private async assertNoSymlinks(root: string): Promise<void> {
    const stack = [root];
    while (stack.length) {
      const directory = stack.pop()!;
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`SEIM verification refuses symbolic link: ${path.relative(root, fullPath)}`);
        if (entry.isDirectory()) stack.push(fullPath);
      }
    }
  }

  private async assertNoSymlinkPath(root: string, target: string): Promise<void> {
    let current = root;
    for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        if ((await fs.promises.lstat(current)).isSymbolicLink()) throw new Error(`SEIM verification refuses symbolic link: ${path.relative(root, current)}`);
      } catch (error: any) {
        if (error?.code === 'ENOENT') break;
        throw error;
      }
    }
  }

  private staticCheck(files: ChangeFile[]): VerificationCheck {
    const start = Date.now();
    for (const file of files) {
      const code = file.content || '';
      if (/\beval\s*\(|\bnew\s+Function\s*\(|child_process|process\.env\.[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|KEY)/i.test(code)) {
        return { name: 'static-security', passed: false, durationMs: Date.now() - start, reason: `Unsafe generated operation in ${file.path}` };
      }
      if (file.path.split('/').some(segment => segment === '..')) {
        return { name: 'static-security', passed: false, durationMs: Date.now() - start, reason: `Path traversal in ${file.path}` };
      }
    }
    return { name: 'static-security', passed: true, durationMs: Date.now() - start };
  }

  private async runCheck(name: string, command: string, cwd: string, timeout: number): Promise<VerificationCheck> {
    const start = Date.now();
    const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(key)));
    try {
      const result = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...safeEnv, CI: '1', NODE_ENV: 'test', SEIM_ENGINEER_WORKER: '1' },
      });
      return { name, command, passed: true, durationMs: Date.now() - start, output: `${result.stdout}\n${result.stderr}`.slice(-10000) };
    } catch (error: any) {
      return { name, command, passed: false, durationMs: Date.now() - start, output: `${error?.stdout || ''}\n${error?.stderr || error?.message || error}`.slice(-10000), reason: 'Command failed' };
    }
  }
}
