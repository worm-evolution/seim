import * as vm from 'vm';
import { Request, Response, NextFunction } from 'express';

const BUILTINS = new Set([
  'buffer', 'crypto', 'events', 'path', 'querystring', 'stream', 'string_decoder',
  'url', 'util', 'timers'
]);

export class Sandbox {
  private ivm: any | undefined;

  constructor(private readonly requireIsolatedVm = false) {
    if (!requireIsolatedVm) return;
    try {
      this.ivm = require('isolated-vm');
    } catch {
      if (this.requireIsolatedVm) {
        throw new Error('SEIM production requires isolated-vm; install the optional isolated-vm dependency before starting.');
      }
    }
  }

  public async run(
    code: string,
    originalSource: string,
    req: Request,
    res: Response,
    _next: NextFunction,
    timeoutMs = 500
  ): Promise<unknown> {
    // Static analysis check to detect and prevent dynamic or blocked require imports
    const blockedPattern = /require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    let match;
    while ((match = blockedPattern.exec(code)) !== null) {
      const moduleName = match[1];
      if (!BUILTINS.has(moduleName)) {
        throw new Error(`SEIM sandbox security violation: module '${moduleName}' is not allowed`);
      }
    }

    const body = this.extractFunctionBody(code);
    if (this.ivm) {
      return this.runIsolated(body, req, res, timeoutMs);
    }
    return this.runVm(body, originalSource, req, res, timeoutMs);
  }

  private async runIsolated(body: string, req: Request, res: Response, timeoutMs: number): Promise<unknown> {
    const isolate = new this.ivm.Isolate({ memoryLimit: 128 });
    const context = isolate.createContextSync();

    try {
      const reqSnapshot = this.snapshotRequest(req);

      const json = typeof res.json === 'function' ? res.json.bind(res) : () => undefined;
      const send = typeof res.send === 'function' ? res.send.bind(res) : () => undefined;
      const status = typeof res.status === 'function' ? res.status.bind(res) : () => res;
      const end = typeof res.end === 'function' ? res.end.bind(res) : () => undefined;
      context.global.setSync('__resJson', new this.ivm.Reference(json));
      context.global.setSync('__resSend', new this.ivm.Reference(send));
      context.global.setSync('__resStatus', new this.ivm.Reference(status));
      context.global.setSync('__resEnd', new this.ivm.Reference(end));
      context.global.setSync('req', new this.ivm.ExternalCopy(reqSnapshot).copyInto());

      // Bind dynamic in-memory database functions for isolated-vm execution
      context.global.setSync('__seimDbCollectionInsert', new this.ivm.Reference((name: string, doc: any) => {
        return (global as any).seimDb.collection(name).insert(doc);
      }));
      context.global.setSync('__seimDbCollectionFind', new this.ivm.Reference((name: string, query: any) => {
        return (global as any).seimDb.collection(name).find(query);
      }));
      context.global.setSync('__seimDbCollectionUpdate', new this.ivm.Reference((name: string, query: any, updates: any) => {
        return (global as any).seimDb.collection(name).update(query, updates);
      }));
      context.global.setSync('__seimDbCollectionRemove', new this.ivm.Reference((name: string, query: any) => {
        return (global as any).seimDb.collection(name).remove(query);
      }));

      context.evalSync(`
        var res = {
          json: function(body) {
            __resJson.applySync(undefined, [body], { arguments: { copy: true }, result: { reference: true } });
            return res;
          },
          send: function(body) {
            __resSend.applySync(undefined, [body], { arguments: { copy: true }, result: { reference: true } });
            return res;
          },
          status: function(code) {
            __resStatus.applySync(undefined, [code], { arguments: { copy: true }, result: { reference: true } });
            return res;
          },
          end: function() {
            __resEnd.applySync(undefined, [], { arguments: { copy: true }, result: { reference: true } });
          }
        };

        globalThis.seimDb = {
          collection: function(name) {
            return {
              insert: function(doc) {
                var r = __seimDbCollectionInsert.applySync(undefined, [name, doc], { arguments: { copy: true }, result: { copy: true } });
                return Promise.resolve(r);
              },
              find: function(query) {
                var r = __seimDbCollectionFind.applySync(undefined, [name, query || {}], { arguments: { copy: true }, result: { copy: true } });
                return Promise.resolve(r);
              },
              update: function(query, updates) {
                var r = __seimDbCollectionUpdate.applySync(undefined, [name, query, updates], { arguments: { copy: true }, result: { copy: true } });
                return Promise.resolve(r);
              },
              remove: function(query) {
                var r = __seimDbCollectionRemove.applySync(undefined, [name, query], { arguments: { copy: true }, result: { copy: true } });
                return Promise.resolve(r);
              }
            };
          }
        };
      `);

      const script = isolate.compileScriptSync(`(async function() {\n${body}\nif (typeof handler === 'function') { return await handler(req, res); }\n})`);
      const fn = script.runSync(context, { reference: true });
      const result = await fn.apply(undefined, [], { timeout: timeoutMs, result: { promise: true, copy: true } });
      isolate.dispose();
      return result;
    } catch (err) {
      isolate.dispose();
      throw err;
    }
  }

  private async runVm(body: string, originalSource: string, req: Request, res: Response, timeoutMs: number): Promise<unknown> {
    const modules = this.getModules(originalSource);
    // Extract functions referenced in the original source that live in the handler's closure
    const closureFns = this.extractClosureFunctions(originalSource);

    const context = vm.createContext({
      console,
      Buffer,
      Promise,
      JSON,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Date,
      Math,
      Error,
      RegExp,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Symbol,
      BigInt,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      setImmediate,
      clearImmediate,
      structuredClone: typeof structuredClone !== 'undefined' ? structuredClone : (obj: any) => JSON.parse(JSON.stringify(obj)),
      require: (name: string) => this.requireSafe(name, modules),
      req,
      res,
      ...closureFns,
    });

    const wrapped = `(async (req, res) => {\n${body}\nif (typeof handler === 'function') { return await handler(req, res); }\n})(req, res)`;
    const script = new vm.Script(wrapped, { filename: 'seim-shadow.js' });
    const start = Date.now();
    
    try {
      const result = script.runInContext(context, { timeout: timeoutMs });
      const remaining = Math.max(1, timeoutMs - (Date.now() - start));

      return await Promise.race([
        result as Promise<unknown>,
        new Promise((_, reject) => setTimeout(() => reject(new Error('SEIM sandbox wall-clock timeout')), remaining)),
      ]);
    } catch (err) {
      throw err;
    }
  }

  /**
   * Attempt to extract named functions from the original handler source
   * so they're available in the sandbox.  This is best-effort — if the
   * function isn't a simple named reference we skip it.
   */
  private extractClosureFunctions(source: string): Record<string, Function> {
    const fns: Record<string, Function> = {};
    // Look for function calls in the source (e.g. await fetchData(...))
    const callRegex = /(?:await\s+)?(\w+)\s*\(/g;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();
    const builtins = new Set(['Promise', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
      'Date', 'Math', 'Error', 'RegExp', 'Map', 'Set', 'console', 'Buffer', 'setTimeout',
      'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
      'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
      'require', 'structuredClone', 'fetch']);
    while ((match = callRegex.exec(source)) !== null) {
      const name = match[1];
      if (!name || builtins.has(name) || seen.has(name)) continue;
      if (name === 'res' || name === 'req' || name === 'next') continue;
      // Skip keywords
      if (['if', 'for', 'while', 'switch', 'return', 'throw', 'new', 'typeof', 'void', 'delete', 'async', 'await', 'const', 'let', 'var', 'function'].includes(name)) continue;
      seen.add(name);
    }
    return fns;
  }

  private extractFunctionBody(fnSource: string): string {
    const trimmed = fnSource.trim().replace(/^;+|;+$/g, '');
    let m = trimmed.match(/^(?:async\s+)?function\s*[\w]*\s*\([^)]*\)\s*\{([\s\S]*)\}\s*;?$/);
    if (m) return m[1].trim();
    m = trimmed.match(/^(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{([\s\S]*)\}\s*;?$/);
    if (m) return m[1].trim();
    m = trimmed.match(/^(?:async\s+)?\([^)]*\)\s*=>\s*\{([\s\S]*)\}\s*;?$/);
    if (m) return m[1].trim();
    m = trimmed.match(/=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{([\s\S]*)\}\s*;?$/);
    if (m) return m[1].trim();
    return trimmed;
  }

  private snapshotRequest(req: Request): Record<string, any> {
    const snapshot: Record<string, any> = {
      method: req.method,
      url: req.url,
      ip: req.ip,
      headers: req.headers,
      params: req.params,
      query: req.query,
      body: req.body,
    };
    try {
      return JSON.parse(JSON.stringify(snapshot));
    } catch {
      return snapshot;
    }
  }

  private getModules(originalSource: string): Map<string, any> {
    const regex = /require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    const modules = new Map<string, any>();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(originalSource)) !== null) {
      const name = match[1];
      if (BUILTINS.has(name)) {
        try { modules.set(name, require(name)); } catch {}
      } else if (!name.startsWith('.')) {
        try { modules.set(name, require(name)); } catch {}
      }
    }
    return modules;
  }

  private requireSafe(name: string, modules: Map<string, any>): any {
    if (modules.has(name)) return modules.get(name);
    if (BUILTINS.has(name)) return require(name);
    throw new Error(`SEIM sandbox: module '${name}' is not in the allowed import list`);
  }
}
