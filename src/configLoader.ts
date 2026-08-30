import * as path from 'path';
import * as fs from 'fs';
import { SeimConfig } from './types';

/**
 * Auto-discover seim configuration from the project root.
 *
 * Looks for (in order):
 *   1. .seimrc.json
 *   2. seim.config.js
 *   3. package.json "seim" key
 *
 * Returns undefined if none found.
 */
export function loadConfigFromFile(cwd: string = process.cwd(), options: { allowJavaScript?: boolean } = {}): Partial<SeimConfig> | undefined {
  // 1. .seimrc.json
  const rcPath = path.join(cwd, '.seimrc.json');
  if (fs.existsSync(rcPath)) {
    try {
      const raw = fs.readFileSync(rcPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      // malformed — ignore
    }
  }

  // 2. seim.config.js
  const jsPath = path.join(cwd, 'seim.config.js');
  if (options.allowJavaScript === true && fs.existsSync(jsPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(jsPath);
      return mod.default || mod;
    } catch {
      // ignore
    }
  }

  // 3. package.json#seim
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const raw = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw);
      if (pkg.seim && typeof pkg.seim === 'object') return pkg.seim;
    } catch {
      // ignore
    }
  }

  return undefined;
}
