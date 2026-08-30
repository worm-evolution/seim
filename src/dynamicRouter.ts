import { RequestHandler } from 'express';
import { ProductionManager } from './productionManager';
import { StableCanaryAssigner, CanaryAssigner } from './canaryAssignment';
import { normalizePath } from './routeNormalizer';

export class DynamicRouter {
  private originalHandlers: Map<string, RequestHandler> = new Map();
  private optimizedHandlers: Map<string, RequestHandler> = new Map();
  private productionManager: ProductionManager;
  private canaryAssigner: CanaryAssigner;

  constructor(productionManager: ProductionManager, canaryAssigner: CanaryAssigner = new StableCanaryAssigner()) {
    this.productionManager = productionManager;
    this.canaryAssigner = canaryAssigner;
  }

  public registerHandler(routeKey: string, handler: RequestHandler, type: 'original' | 'optimized'): void {
    if (type === 'original') {
      this.originalHandlers.set(routeKey, handler);
    } else {
      this.optimizedHandlers.set(routeKey, handler);
    }
  }

  public registerRoute(routePath: string, method: string, handler: RequestHandler): void {
    const routeKey = `${method.toUpperCase()} ${routePath}`;
    this.optimizedHandlers.set(routeKey, handler);
    this.originalHandlers.set(routeKey, handler);
  }

  public hasHandler(routeKey: string): boolean {
    if (this.optimizedHandlers.has(routeKey) || this.originalHandlers.has(routeKey)) return true;
    const parts = routeKey.split(' ');
    if (parts.length === 2) {
      const normalizedKey = `${parts[0]} ${normalizePath(parts[1])}`;
      return this.optimizedHandlers.has(normalizedKey) || this.originalHandlers.has(normalizedKey);
    }
    return false;
  }

  public getHandler(routeKey: string, req?: any): RequestHandler {
    const deployment = this.productionManager.getDeployment(routeKey);
    
    let optHandler = this.optimizedHandlers.get(routeKey);
    let origHandler = this.originalHandlers.get(routeKey);

    if (!optHandler && !origHandler) {
      const parts = routeKey.split(' ');
      if (parts.length === 2) {
        const normalizedKey = `${parts[0]} ${normalizePath(parts[1])}`;
        optHandler = this.optimizedHandlers.get(normalizedKey);
        origHandler = this.originalHandlers.get(normalizedKey);
      }
    }

    // If no deployment or original version, return original handler
    if (!deployment || deployment.version === 'original') {
      return origHandler || optHandler || this.fallbackHandler(routeKey);
    }

    // If optimized version, check canary percentage via stable hash assigner
    const shouldUseOptimized = this.canaryAssigner.shouldUseCanary(req, deployment.canaryPercent);
    
    if (shouldUseOptimized) {
      return optHandler || origHandler || this.fallbackHandler(routeKey);
    }
    
    return origHandler || optHandler || this.fallbackHandler(routeKey);
  }

  public createDynamicMiddleware(routeKey: string): RequestHandler {
    return (req, res, next) => {
      const handler = this.getHandler(routeKey, req);
      if (handler) {
        handler(req, res, next);
      } else {
        next();
      }
    };
  }

  public swapHandler(routeKey: string, newHandler: RequestHandler, type: 'original' | 'optimized'): void {
    if (type === 'original') {
      this.originalHandlers.set(routeKey, newHandler);
    } else {
      this.optimizedHandlers.set(routeKey, newHandler);
    }
  }

  public removeOptimizedHandler(routeKey: string): void {
    this.optimizedHandlers.delete(routeKey);
  }

  private fallbackHandler(routeKey: string): RequestHandler {
    return (req, res, next) => {
      console.error(`[DYNAMIC ROUTER] No handler found for ${routeKey}`);
      res.status(500).json({ error: 'Internal server error - handler not found' });
    };
  }

  public getHandlerCounts(): { original: number; optimized: number } {
    return {
      original: this.originalHandlers.size,
      optimized: this.optimizedHandlers.size,
    };
  }
}
