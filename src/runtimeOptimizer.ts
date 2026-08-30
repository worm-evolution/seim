import { Request, Response, NextFunction, RequestHandler } from 'express';

export interface CacheWrapperOptions {
  ttlMs?: number;
  maxEntries?: number;
  keyGenerator?: (req: Request) => string;
  methods?: string[];
}

export interface ConcurrencyWrapperOptions {
  maxConcurrent?: number;
  queueTimeoutMs?: number;
}

/**
 * High-performance runtime decorator engine that wraps live route handlers in-place.
 * 
 * CRITICAL ARCHITECTURAL GUARANTEE:
 * Because this decorates the actual JavaScript function instance directly rather than
 * calling `handle.toString()` and executing in a detached VM, it preserves 100% of lexical
 * closures, database pools, ORM models, and imported modules without ReferenceErrors.
 */
export class RuntimeOptimizer {
  /**
   * Decorates a handler with an intelligent LRU micro-cache.
   */
  public static wrapWithCache(
    originalHandler: RequestHandler,
    options: CacheWrapperOptions = {}
  ): RequestHandler {
    const ttlMs = options.ttlMs || 30000; // 30s default
    const maxEntries = options.maxEntries || 1000;
    const allowedMethods = (options.methods || ['GET', 'HEAD']).map(m => m.toUpperCase());
    const cache = new Map<string, { body: any; headers: Record<string, any>; statusCode: number; expiresAt: number }>();

    const defaultKeyGen = (req: Request) => {
      const p = req.path || req.url || '/';
      const q = req.query ? JSON.stringify(req.query) : '';
      return `${req.method.toUpperCase()}:${p}:${q}`;
    };

    const keyGen = options.keyGenerator || defaultKeyGen;

    return (req: Request, res: Response, next: NextFunction): void => {
      const method = (req.method || 'GET').toUpperCase();
      if (!allowedMethods.includes(method)) {
        return originalHandler(req, res, next);
      }

      const cacheKey = keyGen(req);
      const cached = cache.get(cacheKey);
      const now = Date.now();

      if (cached && cached.expiresAt > now) {
        res.setHeader('X-SEIM-Cache', 'HIT');
        if (cached.headers) {
          for (const [k, v] of Object.entries(cached.headers)) {
            if (k.toLowerCase() !== 'content-length') {
              res.setHeader(k, v);
            }
          }
        }
        res.status(cached.statusCode);
        res.send(cached.body);
        return;
      }

      // Intercept and record the response
      const originalSend = res.send.bind(res);
      const originalJson = res.json.bind(res);
      let capturedBody: any = null;

      res.send = function (body: any) {
        capturedBody = body;
        const statusCode = typeof res.statusCode === 'number' ? res.statusCode : 200;
        if (statusCode < 400) {
          if (cache.size >= maxEntries) {
            const firstKey = cache.keys().next().value;
            if (firstKey) cache.delete(firstKey);
          }
          cache.set(cacheKey, {
            body,
            headers: (res as any).getHeaders ? (res as any).getHeaders() : {},
            statusCode,
            expiresAt: Date.now() + ttlMs,
          });
        }
        res.setHeader('X-SEIM-Cache', 'MISS');
        return originalSend(body);
      };

      res.json = function (body: any) {
        capturedBody = body;
        return (res.send as any)(body);
      };

      return (originalHandler as any)(req, res, next);
    };
  }

  /**
   * Decorates a handler with a concurrency limiter / queue to prevent database pool exhaustion.
   */
  public static wrapWithConcurrencyLimit(
    originalHandler: RequestHandler,
    options: ConcurrencyWrapperOptions = {}
  ): RequestHandler {
    const maxConcurrent = options.maxConcurrent || 50;
    let activeRequests = 0;
    const queue: Array<() => void> = [];

    return (req: Request, res: Response, next: NextFunction): void => {
      const execute = () => {
        activeRequests++;
        const onFinish = () => {
          activeRequests--;
          if (queue.length > 0) {
            const nextInQueue = queue.shift();
            if (nextInQueue) nextInQueue();
          }
        };

        res.on('finish', onFinish);
        res.on('close', onFinish);

        originalHandler(req, res, next);
      };

      if (activeRequests < maxConcurrent) {
        execute();
      } else {
        queue.push(execute);
      }
    };
  }
}
