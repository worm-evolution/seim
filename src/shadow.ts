import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ExperimentReport } from './types';

export interface ShadowRunResult {
  v1Latency: number;
  v1Error: boolean;
  v1Output: unknown;
  v2Latency: number;
  v2Error: boolean;
  v2Output: unknown;
  sampleSize: number;
}

export class ShadowTestEngine {
  private samples: Map<string, { v1Latency: number; v2Latency: number; v1Error: boolean; v2Error: boolean }[]> = new Map();

  constructor() {}

  public async run(
    routeKey: string,
    original: RequestHandler,
    optimized: RequestHandler,
    req: Request,
    allowedMethods: string[] = ['GET', 'HEAD', 'OPTIONS']
  ): Promise<ShadowRunResult> {
    const method = (req?.method || 'GET').toUpperCase();
    if (!allowedMethods.map(m => m.toUpperCase()).includes(method)) {
      throw new Error(`Shadow testing not permitted for mutating method ${method}. Gated to read-only methods: ${allowedMethods.join(', ')}`);
    }
    const t1 = process.hrtime.bigint();
    let v1Error = false;
    let v1Output: unknown;
    try {
      v1Output = await this.promiseHandler(original, req);
    } catch {
      v1Error = true;
    }
    const v1Latency = Number(process.hrtime.bigint() - t1) / 1e6;

    const t2 = process.hrtime.bigint();
    let v2Error = false;
    let v2Output: unknown;
    try {
      const clonedReq = this.cloneRequest(req);
      v2Output = await this.promiseHandler(optimized, clonedReq);
    } catch {
      v2Error = true;
    }
    const v2Latency = Number(process.hrtime.bigint() - t2) / 1e6;

    const list = this.samples.get(routeKey) || [];
    list.push({ v1Latency, v2Latency, v1Error, v2Error });
    if (list.length > 1000) list.shift();
    this.samples.set(routeKey, list);

    return {
      v1Latency,
      v1Error,
      v1Output,
      v2Latency,
      v2Error,
      v2Output,
      sampleSize: list.length,
    };
  }

  public getReport(routeKey: string): ExperimentReport | undefined {
    const list = this.samples.get(routeKey);
    if (!list || list.length === 0) return undefined;
    const v1Latencies = list.map((s) => s.v1Latency);
    const v2Latencies = list.map((s) => s.v2Latency);
    return {
      candidateId: routeKey,
      routeKey,
      v1Latency: v1Latencies.reduce((a, b) => a + b, 0) / v1Latencies.length,
      v2Latency: v2Latencies.reduce((a, b) => a + b, 0) / v2Latencies.length,
      v1Errors: list.filter((s) => s.v1Error).length,
      v2Errors: list.filter((s) => s.v2Error).length,
      v1Memory: process.memoryUsage().heapUsed,
      v2Memory: process.memoryUsage().heapUsed,
      sampleSize: list.length,
      promoted: false,
      rolledBack: false,
    };
  }

  private cloneRequest(req: Request): Request {
    return {
      method: req.method,
      url: req.url,
      headers: { ...req.headers, 'x-seim-shadow': 'true' },
      params: { ...req.params },
      query: { ...req.query },
      body: req.body ? JSON.parse(JSON.stringify(req.body)) : undefined,
      ip: req.ip,
      path: req.path,
      hostname: req.hostname,
      protocol: req.protocol,
      isShadow: true,
      isShadowExecution: true,
    } as unknown as Request;
  }

  private promiseHandler(handler: RequestHandler, req: Request): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let finished = false;
      let captured: unknown;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve(captured);
      };
      const stubRes = {
        finished: false,
        headersSent: false,
        writableEnded: false,
        statusCode: 200,
        json: function (body: any) { captured = body; finish(); return stubRes; },
        send: function (body: any) { captured = body; finish(); return stubRes; },
        status: function () { return stubRes; },
        setHeader: function () { return stubRes; },
        getHeader: function () { return ''; },
        writeHead: function () { return stubRes; },
        end: finish,
      } as unknown as Response;
      const next: NextFunction = (err?: any) => (err ? reject(err) : finish());
      try {
        const out = (handler as any)(req, stubRes, next);
        if (out && typeof out.then === 'function') {
          (out as Promise<unknown>).then((x) => { captured = x ?? captured; finish(); }, reject);
        }
      } catch (err) {
        reject(err);
      }
    });
  }
}
