import { FrameworkAdapter, RouteHandlerInfo, OnRequestCallback, OnResponseCallback } from './types';
import { normalizePath } from '../routeNormalizer';

/**
 * Fastify adapter.
 *
 * Fastify uses hooks instead of middleware. This adapter returns a Fastify
 * plugin that registers `onRequest` and `onResponse` hooks.
 *
 * Usage:
 *   const { seim } = require('seim-core');
 *   const s = seim({ framework: 'fastify' });
 *   fastify.register(s.plugin());
 */
export class FastifyAdapter implements FrameworkAdapter {
  readonly name = 'fastify';

  private handlerMap = new Map<string, { handler: Function; source: string }>();

  createMiddleware(onRequest: OnRequestCallback, onResponse: OnResponseCallback): any {
    const self = this;

    // Return a Fastify plugin
    return function seimPlugin(fastify: any, _opts: any, done: Function) {
      fastify.addHook('onRequest', (request: any, reply: any, hookDone: Function) => {
        const routeKey = self.getRouteKey(request);
        (request as any).__seimStart = process.hrtime.bigint();
        (request as any).__seimRouteKey = routeKey;
        onRequest(request, reply, routeKey);
        hookDone();
      });

      fastify.addHook('onResponse', (request: any, reply: any, hookDone: Function) => {
        const start: bigint = (request as any).__seimStart || process.hrtime.bigint();
        const routeKey: string = (request as any).__seimRouteKey || self.getRouteKey(request);
        const duration = Number(process.hrtime.bigint() - start) / 1e6;
        const payloadSize = request.headers['content-length'] ? parseInt(request.headers['content-length'], 10) || 0 : 0;

        const info = {
          statusCode: reply.statusCode,
          duration,
          responseSize: 0, // Fastify doesn't expose response body size easily in onResponse
          payloadSize,
          error: reply.statusCode >= 500,
          timeout: false,
        };

        try {
          const result = onResponse(request, reply, routeKey, info);
          if (result && typeof (result as any).catch === 'function') {
            (result as Promise<void>).catch(() => {});
          }
        } catch {
          // never crash
        }
        hookDone();
      });

      done();
    };
  }

  getRouteHandler(_req: any): RouteHandlerInfo | undefined {
    // Fastify doesn't expose route handlers the same way Express does.
    // Optimization in Fastify mode relies on the code being passed directly
    // or analyzed offline via CLI.
    return undefined;
  }

  swapHandler(_routeInfo: RouteHandlerInfo, _newHandler: Function): void {
    // Fastify doesn't support live handler swapping — optimizations are
    // emitted to disk (CI/CD mode) and applied on next deploy.
  }

  getRouteKey(req: any): string {
    const route = req.routeOptions?.url || req.routerPath;
    if (route) return route;
    return normalizePath(req.url || '/');
  }
}
