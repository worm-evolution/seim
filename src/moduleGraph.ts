import * as fs from 'fs';
import * as path from 'path';

export interface ModuleNode {
  filePath: string;
  relativePath: string;
  imports: string[];
  exportedSymbols: string[];
  callers: string[];
  sourceCode?: string;
}

/**
 * Multi-File Dependency Graph & Whole-Project Context Analyzer.
 * 
 * Statically analyzes import and require() dependency trees across the project
 * to bundle relevant helper functions, ORM models, and utility modules into LLM prompts.
 * Performs impact analysis to verify cross-module safety before promotions.
 */
export class ModuleGraph {
  private nodes: Map<string, ModuleNode> = new Map();
  private rootDir: string;

  constructor(rootDir: string = process.cwd()) {
    this.rootDir = path.resolve(rootDir);
  }

  /**
   * Scans a directory and builds an in-memory dependency graph.
   */
  public async buildGraph(targetDir: string = this.rootDir): Promise<Map<string, ModuleNode>> {
    this.nodes.clear();
    const files = this.collectSourceFiles(targetDir);

    for (const file of files) {
      const rel = path.relative(this.rootDir, file);
      try {
        const content = fs.readFileSync(file, 'utf8');
        const imports = this.extractImports(file, content);
        const exportedSymbols = this.extractExports(content);

        this.nodes.set(file, {
          filePath: file,
          relativePath: rel,
          imports,
          exportedSymbols,
          callers: [],
          sourceCode: content,
        });
      } catch {
        // Skip unreadable files
      }
    }

    // Build reverse caller relationships
    for (const [filePath, node] of this.nodes.entries()) {
      for (const imp of node.imports) {
        const targetNode = this.nodes.get(imp);
        if (targetNode && !targetNode.callers.includes(filePath)) {
          targetNode.callers.push(filePath);
        }
      }
    }

    return this.nodes;
  }

  /**
   * Bundles full context for a given route file (including imported helpers and schemas).
   */
  public getContextForRoute(filePath: string): {
    source: string;
    dependencies: Array<{ path: string; code: string }>;
    impactedCallers: string[];
  } {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.rootDir, filePath);
    const node = this.nodes.get(absPath);

    if (!node) {
      return {
        source: fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : '',
        dependencies: [],
        impactedCallers: [],
      };
    }

    const dependencies = node.imports
      .map(impPath => {
        const impNode = this.nodes.get(impPath);
        return impNode && impNode.sourceCode
          ? { path: impNode.relativePath, code: impNode.sourceCode }
          : null;
      })
      .filter((d): d is { path: string; code: string } => d !== null);

    return {
      source: node.sourceCode || '',
      dependencies,
      impactedCallers: node.callers.map(c => path.relative(this.rootDir, c)),
    };
  }

  /**
   * Returns all routes and modules impacted if a specific file is modified.
   */
  public checkImpact(filePath: string): string[] {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.rootDir, filePath);
    const node = this.nodes.get(absPath);
    if (!node) return [];
    return node.callers.map(c => path.relative(this.rootDir, c));
  }

  private collectSourceFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'dist', '.seim-storage', 'coverage'].includes(entry.name)) {
          results.push(...this.collectSourceFiles(fullPath));
        }
      } else if (/\.(js|ts|jsx|tsx|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  private extractImports(filePath: string, content: string): string[] {
    const imports: string[] = [];
    const dir = path.dirname(filePath);

    // Match import ... from '...' or require('...')
    const importRegex = /(?:import\s+(?:[\w\s{},*]+)\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    let match;

    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1] || match[2];
      if (importPath && (importPath.startsWith('.') || importPath.startsWith('/'))) {
        const resolved = this.resolveModulePath(dir, importPath);
        if (resolved) imports.push(resolved);
      }
    }

    return imports;
  }

  private resolveModulePath(dir: string, relPath: string): string | null {
    const base = path.resolve(dir, relPath);
    const extensions = ['', '.ts', '.js', '.tsx', '.jsx', '/index.ts', '/index.js'];

    for (const ext of extensions) {
      const candidate = base + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
    return null;
  }

  private extractExports(content: string): string[] {
    const exports: string[] = [];
    const exportRegex = /(?:export\s+(?:default\s+)?(?:class|function|const|let|var|type|interface)\s+([a-zA-Z0-9_$]+)|module\.exports\s*=\s*([a-zA-Z0-9_$]+)|exports\.([a-zA-Z0-9_$]+))/g;
    let match;

    while ((match = exportRegex.exec(content)) !== null) {
      const sym = match[1] || match[2] || match[3];
      if (sym) exports.push(sym);
    }
    return exports;
  }
}
