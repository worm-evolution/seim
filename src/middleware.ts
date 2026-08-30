import { Request, Response, NextFunction, RequestHandler } from 'express';
import { SeimConfig, OptimizationCandidate } from './types';
import { InMemoryMetricsStore } from './metrics';
import { OptimizationEngine } from './optimization';
import { ValidationEngine } from './validation';
import { ShadowTestEngine } from './shadow';
import { RollbackEngine } from './rollback';
import { LearningMemoryStore } from './learning';
import { Sandbox } from './sandbox';
import { ShadowLimiter } from './shadowLimiter';
import { MetricsAnalyzer } from './metricsAnalyzer';
import { EndpointTracker } from './endpointTracker';
import { CiCdOptimizer } from './ciCdOptimizer';
import { FrameworkAdapter } from './adapters/types';
import { SeimEventBus } from './events';
import { Logger } from './logger';
import { OptimizationWorker } from './worker';
import { FeatureScaffolder } from './scaffolder';
import { CandidateLifecycleManager, ShadowSample } from './candidateLifecycle';
import { DynamicRouter } from './dynamicRouter';

interface MiddlewareDeps {
  metrics: InMemoryMetricsStore;
  optimization: OptimizationEngine;
  validation: ValidationEngine;
  shadow: ShadowTestEngine;
  rollback: RollbackEngine;
  learning: LearningMemoryStore;
  sandbox: Sandbox;
  shadowLimiter: ShadowLimiter;
  metricsAnalyzer: MetricsAnalyzer;
  endpointTracker: EndpointTracker;
  adapter: FrameworkAdapter;
  events: SeimEventBus;
  logger: Logger;
  worker: OptimizationWorker;
  scaffolder: FeatureScaffolder;
  dynamicRouter?: DynamicRouter;
}

export function createListener(
  config: SeimConfig,
  deps: MiddlewareDeps,
  behaviorMiddleware?: (req: any, res: any, next: () => void) => void
): () => any {
  const { adapter, events, logger, worker } = deps;

  // Set up the worker processor — this runs optimization analysis off the request path
  worker.setProcessor(async (task) => {
    await processOptimization(config, deps, task.routeKey);
  });

  return function listener(): any {
    const innerMiddleware = adapter.createMiddleware(
      // onRequest — lightweight, just records start time
      (_req: any, _res: any, _routeKey: string) => {},

      // onResponse — records metrics, enqueues optimization work
      (_req: any, _res: any, routeKey: string, info) => {
        try {
          // Cache source code for background worker (req.route is populated on response finish)
          const routeInfo = findRouteHandler(_req);
          if (routeInfo) {
            setEvictingMap(sourceCache, routeKey, routeInfo.source);
          }

          // Check for candidates that need shadow testing (strictly gated to read-only methods)
          const liveCandidate = candidateLifecycle.getCandidateForShadow(routeKey);
          const reqMethod = (_req?.method || 'GET').toUpperCase();
          const allowedMethods = config.experiment.shadowAllowedMethods || ['GET', 'HEAD', 'OPTIONS'];
          if (liveCandidate && routeInfo && config.mode === 'bypass' && allowedMethods.map(m => m.toUpperCase()).includes(reqMethod)) {
            // DO NOT delete the candidate — keep it for sample accumulation
            const pending = liveCandidate.candidate;
            const optimized = buildOptimizedHandler(pending, deps.sandbox, config.experiment.sandboxTimeoutMs || 500);
            deps.shadow.run(routeKey, routeInfo.handle, optimized, _req, allowedMethods)
              .then(async (result) => {
                // Record shadow sample
                const sample: ShadowSample = {
                  v1Latency: result.v1Latency,
                  v2Latency: result.v2Latency,
                  v1Error: result.v1Error,
                  v2Error: result.v2Error,
                  v1Output: result.v1Output,
                  v2Output: result.v2Output,
                  sampledAt: Date.now(),
                };
                const samplesComplete = candidateLifecycle.recordShadowSample(routeKey, sample);

                const validated = await deps.validation.validate(pending, result.v1Output, result.v2Output, _req, {
                  v1Latency: result.v1Latency,
                  v2Latency: result.v2Latency,
                });
                if (validated.overall) {
                  deps.rollback.registerShadow(routeKey, { route: routeInfo.route, index: routeInfo.index }, routeInfo.handle, optimized);

                  // Only evaluate for promotion once enough samples are collected
                  if (samplesComplete) {
                    const report = deps.shadow.getReport(routeKey);
                    if (report) {
                      const evalResult = deps.rollback.evaluate(routeKey, report);
                      if (evalResult === 'promote') {
                        candidateLifecycle.transition(routeKey, 'promoted', 'performance improvement');
                        candidateLifecycle.remove(routeKey);
                        deps.endpointTracker.recordSuccess(routeKey);
                        deps.events.emitEvent('optimization:promoted', {
                          routeKey,
                          candidateId: pending.id,
                          latencyImprovement: result.v1Latency - result.v2Latency,
                        });
                        deps.logger.info('Optimization promoted', {
                          routeKey,
                          candidateId: pending.id,
                          improvement: `${Math.round(result.v1Latency - result.v2Latency)}ms`,
                        });
                      } else if (evalResult === 'manual-review') {
                        candidateLifecycle.transition(routeKey, 'approved', 'awaiting manual review');
                        deps.events.emitEvent('optimization:detected', {
                          routeKey,
                          pattern: pending.pattern,
                          severity: pending.severity,
                          candidateId: pending.id,
                        });
                        deps.logger.info('Optimization candidate ready for manual review', {
                          routeKey,
                          candidateId: pending.id,
                        });
                      } else if (evalResult === 'rollback') {
                        candidateLifecycle.transition(routeKey, 'rejected', 'regression detected');
                        candidateLifecycle.remove(routeKey);
                      }
                    }
                  }
                } else {
                  candidateLifecycle.transition(routeKey, 'rejected', 'Validation failed');
                  candidateLifecycle.remove(routeKey);
                  deps.endpointTracker.markAsNonOptimizable(routeKey, 'Validation failed');
                  deps.events.emitEvent('optimization:rejected', {
                    routeKey,
                    candidateId: pending.id,
                    reason: 'Validation failed',
                  });
                }
              })
              .catch((err) => {
                candidateLifecycle.transition(routeKey, 'rejected', 'Shadow test error');
                candidateLifecycle.remove(routeKey);
                deps.endpointTracker.markAsNonOptimizable(routeKey, 'Shadow test error');
                deps.events.emitEvent('error:sandbox', {
                  routeKey,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
          }

          deps.metrics.record(routeKey, info.duration, info.statusCode, info.responseSize, info.payloadSize, info.error, info.timeout);

          // Feed health data to endpoint tracker
          if (info.error) {
            deps.endpointTracker.recordErrorRequest(routeKey);
          } else {
            deps.endpointTracker.recordHealthyRequest(routeKey);
          }

          // Only enqueue for analysis in bypass mode
          if (config.mode !== 'bypass') return;
          if (deps.rollback.isPromoted(routeKey)) return;
          if (!deps.shadowLimiter.canRun(_req, routeKey)) return;
          if (Math.random() * 100 >= config.experiment.canaryPercent) return;

          const routeMetrics = deps.metrics.forRoute(routeKey);
          if (config.learning.enabled && routeMetrics && routeMetrics.requestCount < config.learning.sampleSize) {
            return;
          }

          if (deps.endpointTracker.shouldSkipOptimization(routeKey)) return;

          if (routeMetrics) {
            const analysis = deps.metricsAnalyzer.analyze(routeKey, routeMetrics);
            if (!analysis.needsOptimization) {
              deps.endpointTracker.markAsOptimizable(routeKey);
              return;
            }
          }

          // Check for anomalies
          const anomaly = (deps.metrics as any).getAnomalies?.(routeKey);
          if (anomaly?.isAnomaly) {
            events.emitEvent('metrics:threshold', {
              routeKey,
              metric: 'latency_anomaly',
              value: anomaly.latestAvg,
              threshold: anomaly.rollingMean + anomaly.stdDev * 3,
            });
          }

          // Enqueue to background worker instead of processing inline
          const priority = routeMetrics ? Math.min(10, Math.round(routeMetrics.requestCount / 100)) : 1;
          worker.enqueue(routeKey, priority);
        } catch (err) {
          events.emitEvent('error:internal', {
            component: 'middleware',
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        }
      },
    );

    return (req: any, res: any, next: any) => {
      const proceed = () => {
        if (req.path === '/seim/sensor.js') {
          res.setHeader?.('Content-Type', 'application/javascript');
          return res.send(SENSOR_CODE);
        }

        if (req.path === '/seim/telemetry' && req.method === 'POST') {
          const body = req.body || {};
          processTelemetry(config, deps, body, req);
          res.status?.(200);
          return res.json?.({ ok: true }) || res.send({ ok: true });
        }

        // Intercept dynamically scaffolded routes and evolved handlers
        const method = (req.method || 'GET').toUpperCase();
        const routePath = req.path || req.url || '/';
        const routeKey = `${method} ${routePath}`;
        if (deps.dynamicRouter && deps.dynamicRouter.hasHandler(routeKey)) {
          const dynamicHandler = deps.dynamicRouter.getHandler(routeKey, req);
          if (dynamicHandler) {
            return dynamicHandler(req, res, next);
          }
        }

        installFrontendInstrumentation(req, res);

        innerMiddleware(req, res, next);
      };

      if (behaviorMiddleware) {
        behaviorMiddleware(req, res, proceed);
      } else {
        proceed();
      }
    };
  };
}

const MAX_INSTRUMENTED_HTML_BYTES = 2 * 1024 * 1024;

function installFrontendInstrumentation(req: any, res: any): void {
  if (req.method === 'HEAD') return;

  // Express static/sendFile streams through write/end rather than res.send.
  // Buffer only bounded HTML responses; every non-HTML response keeps its
  // original streaming behavior.
  if (typeof res.write === 'function' && typeof res.end === 'function') {
    const originalWrite = res.write;
    const originalEnd = res.end;
    let buffered: Buffer[] = [];
    let bufferedBytes = 0;
    let passthrough = false;

    const isHtml = (): boolean => String(res.getHeader?.('content-type') || res.get?.('content-type') || '').toLowerCase().includes('text/html');
    const toBuffer = (chunk: any, encoding?: BufferEncoding): Buffer => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);

    res.write = function(chunk: any, encoding?: BufferEncoding | (() => void), callback?: () => void): boolean {
      if (passthrough || !isHtml()) return originalWrite.call(this, chunk, encoding as any, callback);
      const actualEncoding = typeof encoding === 'string' ? encoding : undefined;
      const actualCallback = typeof encoding === 'function' ? encoding : callback;
      const value = toBuffer(chunk, actualEncoding);
      if (bufferedBytes + value.length > MAX_INSTRUMENTED_HTML_BYTES) {
        passthrough = true;
        for (const previous of buffered) originalWrite.call(this, previous);
        buffered = [];
        bufferedBytes = 0;
        return originalWrite.call(this, value, actualCallback);
      }
      buffered.push(value);
      bufferedBytes += value.length;
      if (actualCallback) process.nextTick(actualCallback);
      return true;
    };

    res.end = function(chunk?: any, encoding?: BufferEncoding | (() => void), callback?: () => void): any {
      if (passthrough || !isHtml()) return originalEnd.call(this, chunk, encoding as any, callback);
      const actualEncoding = typeof encoding === 'string' ? encoding : undefined;
      const actualCallback = typeof encoding === 'function' ? encoding : callback;
      if (chunk !== undefined && chunk !== null) {
        const value = toBuffer(chunk, actualEncoding);
        if (bufferedBytes + value.length > MAX_INSTRUMENTED_HTML_BYTES) {
          for (const previous of buffered) originalWrite.call(this, previous);
          buffered = [];
          return originalEnd.call(this, value, actualCallback);
        }
        buffered.push(value);
      }
      const body = Buffer.concat(buffered).toString('utf8');
      const instrumented = instrumentFrontendHtml(body, req.path || req.url || '/');
      res.removeHeader?.('content-length');
      return originalEnd.call(this, Buffer.from(instrumented, 'utf8'), actualCallback);
    };
    return;
  }

  // Retain compatibility with lightweight response implementations and tests.
  if (typeof res.send === 'function') {
    const originalSend = res.send;
    res.send = function(body: any) {
      const contentType = res.getHeader?.('content-type') || res.get?.('content-type') || '';
      if (body && String(contentType).includes('text/html')) {
        const html = instrumentFrontendHtml(typeof body === 'string' ? body : body.toString('utf8'), req.path || req.url || '/');
        body = typeof body === 'string' ? html : Buffer.from(html, 'utf8');
      }
      return originalSend.call(this, body);
    };
  }
}

function instrumentFrontendHtml(html: string, requestPath: string): string {
  if (!html || !/<\/?(?:html|body)(?:\s|>)/i.test(html)) return html;
  const overrides = frontendOverrides.get(requestPath) || { css: '', js: '' };
  const sensorScript = `<script src="/seim/sensor.js" defer></script>`;
  const styleOverride = overrides.css ? `<style id="seim-overrides">${overrides.css}</style>` : '';
  let result = html;
  if (styleOverride && !result.includes('id="seim-overrides"')) result = result.replace(/<\/head>/i, `${styleOverride}</head>`);
  if (!result.includes('src="/seim/sensor.js"')) result = result.replace(/<\/body>/i, `${sensorScript}</body>`);
  return result;
}

function processTelemetry(config: SeimConfig, deps: MiddlewareDeps, body: any, req: any): void {
  const { logger, events } = deps;
  if (!isPlainObject(body)) return;
  const path = normalizeTelemetryPath(body.path);
  if (!path) return;
  const issues = normalizeTelemetryIssues(body.issues);
  if (issues.length === 0) return;

  logger.info('Received frontend telemetry diagnostics', { path, issueCount: issues.length });
  events.emitEvent('frontend:telemetry_received', { path, issues });

  if (config.mode === 'bypass') {
    optimizeFrontendForTelemetry(config, deps, path, issues).catch(err => {
      logger.warn('Failed to optimize frontend for telemetry', { path, error: err.message });
    });
  }
}

/**
 * Process an optimization for a route — called by the background worker.
 */
async function processOptimization(config: SeimConfig, deps: MiddlewareDeps, routeKey: string): Promise<void> {
  const { adapter, events, logger } = deps;

  // For Express, we need a route handler — but we can't get it without a request.
  // The worker processes the route based on previously seen source code.
  // For now, we store source code when first seen and re-use it.
  const source = sourceCache.get(routeKey);
  if (!source) {
    logger.debug('No cached source for route, skipping', { routeKey });
    return;
  }

  const routeMetrics = deps.metrics.forRoute(routeKey);
  const candidates = await deps.optimization.analyzeWithMetricsCheck(
    routeKey,
    source,
    routeMetrics,
    deps.endpointTracker,
  );

  for (const candidate of candidates) {
    if (!candidate.optimizedCode) continue;

    deps.endpointTracker.recordOptimizationAttempt(routeKey);
    events.emitEvent('optimization:detected', {
      routeKey,
      pattern: candidate.pattern,
      severity: candidate.severity,
      candidateId: candidate.id,
    });

    logger.info('Optimization candidate found', {
      routeKey,
      pattern: candidate.pattern,
      severity: candidate.severity,
      candidateId: candidate.id,
    });

    // In CI/CD mode, emit to disk
    if (config.environment === 'production' && config.production?.ciCd?.enabled) {
      const ciCd = new CiCdOptimizer(config);
      await ciCd.publish(routeKey, candidate, { v1Latency: 0, v2Latency: 0, v1Output: null, v2Output: null });
      logger.info('Candidate published to CI/CD output', { routeKey, candidateId: candidate.id });
      continue;
    }

    // For non-CI/CD, register the candidate in the lifecycle manager
    // for shadow testing on subsequent requests.
    candidateLifecycle.register(routeKey, candidate, config.experiment.shadowSampleSize);
  }
}

// Helper to set entries in a map with LRU eviction (cap at 500 entries)
function setEvictingMap<K, V>(map: Map<K, V>, key: K, value: V, maxSize = 500): void {
  if (map.size >= maxSize && !map.has(key)) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}

// Source code cache keyed by route
const sourceCache = new Map<string, string>();
// Candidate lifecycle manager — replaces the old pendingCandidates Map
// that deleted candidates after one shadow test (bug: stuck candidates)
const candidateLifecycle = new CandidateLifecycleManager();

/**
 * Legacy Express-compatible listener for backward compatibility.
 * Uses the adapter layer internally.
 */
export function createExpressListener(
  config: SeimConfig,
  deps: MiddlewareDeps,
  behaviorMiddleware?: (req: any, res: any, next: () => void) => void
): () => RequestHandler {
  const innerListener = createListener(config, deps, behaviorMiddleware);

  return function listener(): RequestHandler {
    const middleware = innerListener();

    return function seimListener(req: Request, res: Response, next: NextFunction): void {
      // Cache source code for background worker
      const routeInfo = findRouteHandler(req);
      if (routeInfo) {
        setEvictingMap(sourceCache, deps.adapter.getRouteKey(req), routeInfo.source);
      }

      // Check for candidates that need shadow testing (strictly gated to read-only methods)
      const routeKey = deps.adapter.getRouteKey(req);
      const liveCandidate = candidateLifecycle.getCandidateForShadow(routeKey);
      const reqMethod = (req?.method || 'GET').toUpperCase();
      const allowedMethods = config.experiment.shadowAllowedMethods || ['GET', 'HEAD', 'OPTIONS'];
      if (liveCandidate && routeInfo && config.mode === 'bypass' && allowedMethods.map(m => m.toUpperCase()).includes(reqMethod)) {
        // DO NOT delete the candidate — keep it for sample accumulation
        const pending = liveCandidate.candidate;
        const optimized = buildOptimizedHandler(pending, deps.sandbox, config.experiment.sandboxTimeoutMs || 500);
        deps.shadow.run(routeKey, routeInfo.handle, optimized, req, allowedMethods)
          .then(async (result) => {
            // Record shadow sample
            const sample: ShadowSample = {
              v1Latency: result.v1Latency,
              v2Latency: result.v2Latency,
              v1Error: result.v1Error,
              v2Error: result.v2Error,
              v1Output: result.v1Output,
              v2Output: result.v2Output,
              sampledAt: Date.now(),
            };
            const samplesComplete = candidateLifecycle.recordShadowSample(routeKey, sample);

            const validated = await deps.validation.validate(pending, result.v1Output, result.v2Output, req, {
              v1Latency: result.v1Latency,
              v2Latency: result.v2Latency,
            });
            if (validated.overall) {
              deps.rollback.registerShadow(routeKey, { route: routeInfo.route, index: routeInfo.index }, routeInfo.handle, optimized);

              // Only evaluate for promotion once enough samples are collected
              if (samplesComplete) {
                const report = deps.shadow.getReport(routeKey);
                if (report) {
                  const evalResult = deps.rollback.evaluate(routeKey, report);
                  if (evalResult === 'promote') {
                    candidateLifecycle.transition(routeKey, 'promoted', 'performance improvement');
                    candidateLifecycle.remove(routeKey);
                    deps.endpointTracker.recordSuccess(routeKey);
                    deps.events.emitEvent('optimization:promoted', {
                      routeKey,
                      candidateId: pending.id,
                      latencyImprovement: result.v1Latency - result.v2Latency,
                    });
                    deps.logger.info('Optimization promoted', {
                      routeKey,
                      candidateId: pending.id,
                      improvement: `${Math.round(result.v1Latency - result.v2Latency)}ms`,
                    });
                  } else if (evalResult === 'manual-review') {
                    candidateLifecycle.transition(routeKey, 'approved', 'awaiting manual review');
                    deps.logger.info('Optimization candidate ready for manual review', {
                      routeKey,
                      candidateId: pending.id,
                    });
                  } else if (evalResult === 'rollback') {
                    candidateLifecycle.transition(routeKey, 'rejected', 'regression detected');
                    candidateLifecycle.remove(routeKey);
                  }
                }
              }
            } else {
              candidateLifecycle.transition(routeKey, 'rejected', 'Validation failed');
              candidateLifecycle.remove(routeKey);
              deps.endpointTracker.markAsNonOptimizable(routeKey, 'Validation failed');
              deps.events.emitEvent('optimization:rejected', {
                routeKey,
                candidateId: pending.id,
                reason: 'Validation failed',
              });
            }
          })
          .catch((err) => {
            candidateLifecycle.transition(routeKey, 'rejected', 'Shadow test error');
            candidateLifecycle.remove(routeKey);
            deps.endpointTracker.markAsNonOptimizable(routeKey, 'Shadow test error');
            deps.events.emitEvent('error:sandbox', {
              routeKey,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      // Call the adapter middleware
      middleware(req, res, next);
    };
  };
}

function findRouteHandler(req: Request): { route: any; index: number; handle: RequestHandler; source: string } | undefined {
  const route = (req as any).route;
  const stack = route?.stack;
  if (!Array.isArray(stack)) return undefined;
  for (let i = stack.length - 1; i >= 0; i--) {
    const handle = stack[i]?.handle;
    if (typeof handle === 'function') {
      return { route, index: i, handle, source: handle.toString() };
    }
  }
  return undefined;
}

function buildOptimizedHandler(candidate: OptimizationCandidate, sandbox: Sandbox, timeoutMs = 500): RequestHandler {
  return function optimizedHandler(req: Request, res: Response, next: NextFunction): void {
    sandbox.run(candidate.optimizedCode || '', candidate.originalCode || '', req, res, next, timeoutMs).catch((err) => {
      next(err instanceof Error ? err : new Error(String(err)));
    });
  };
}

// Client-side UI diagnostics telemetry overrides cache
export const frontendOverrides = new Map<string, { css: string; js: string }>();

// Telemetry optimization helper using the LLM client
async function optimizeFrontendForTelemetry(config: SeimConfig, deps: MiddlewareDeps, path: string, issues: any[]): Promise<void> {
  const overrides = await deps.optimization.llm.generateFrontendOverrides(path, issues);
  setEvictingMap(frontendOverrides, path, {
    css: sanitizeFrontendCss(overrides?.css),
    js: '',
  });
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeTelemetryPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || !value.startsWith('/')) return undefined;
  if (/[\u0000-\u001f<>"'`\\]/.test(value)) return undefined;
  return value;
}

function normalizeTelemetryIssues(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 25).filter(isPlainObject).map((issue) => {
    const safe: Record<string, string> = {};
    for (const key of ['type', 'element', 'selector', 'message', 'value']) {
      if (typeof issue[key] === 'string' && issue[key].length <= 500 && !/[\u0000-\u001f<>`]/.test(issue[key])) {
        safe[key] = issue[key];
      }
    }
    return safe;
  }).filter(issue => Object.keys(issue).length > 0);
}

function sanitizeFrontendCss(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16_384) return '';
  if (/<|>|url\s*\(|@import|expression\s*\(|javascript\s*:|behavior\s*:/i.test(value)) return '';
  return value;
}

// Sandboxed client-side diagnostics telemetry sensor script
export const SENSOR_CODE = `
(function() {
  const issues = [];
  
  function checkAccessibility() {
    document.querySelectorAll('img').forEach(img => {
      if (!img.hasAttribute('alt') || img.getAttribute('alt').trim() === '') {
        issues.push({ type: 'accessibility', element: img.tagName, selector: getSelector(img), message: 'Missing alt attribute on image' });
      }
    });

    document.querySelectorAll('button').forEach(btn => {
      if (btn.innerText.trim() === '' && !btn.hasAttribute('aria-label') && !btn.hasAttribute('aria-labelledby')) {
        issues.push({ type: 'accessibility', element: btn.tagName, selector: getSelector(btn), message: 'Button has no readable text or ARIA label' });
      }
    });

    document.querySelectorAll('input').forEach(input => {
      if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button') return;
      const id = input.getAttribute('id');
      let hasLabel = false;
      if (id) {
        hasLabel = document.querySelector('label[for="' + id + '"]') !== null;
      }
      if (!hasLabel) {
        let parent = input.parentElement;
        while (parent) {
          if (parent.tagName === 'LABEL') { hasLabel = true; break; }
          parent = parent.parentElement;
        }
      }
      if (!hasLabel) {
        issues.push({ type: 'accessibility', element: input.tagName, selector: getSelector(input), message: 'Form input is missing an associated label' });
      }
    });
  }

  function checkLayoutOverflow() {
    const width = window.innerWidth;
    document.querySelectorAll('*').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.right > width + 1) {
        issues.push({ type: 'layout', element: el.tagName, selector: getSelector(el), message: 'Element overflows viewport horizontally (right: ' + rect.right + 'px, viewport: ' + width + 'px)' });
      }
    });
  }

  function setupFormUXTracking() {
    document.addEventListener('invalid', (e) => {
      issues.push({ type: 'form-ux', element: e.target.tagName, selector: getSelector(e.target), message: 'Form field validation failed (constraint: ' + e.target.validationMessage + ')' });
    }, true);
  }

  function getSelector(el) {
    if (el.id) return '#' + el.id;
    let path = [];
    while (el && el.nodeType === Node.ELEMENT_NODE) {
      let selector = el.nodeName.toLowerCase();
      if (el.className) {
        selector += '.' + Array.from(el.classList).join('.');
      }
      path.unshift(selector);
      el = el.parentNode;
    }
    return path.join(' > ');
  }

  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          const fid = entry.processingStart - entry.startTime;
          if (fid > 100) {
            issues.push({ type: 'performance', message: 'First Input Delay (FID) exceeded 100ms: ' + Math.round(fid) + 'ms', value: fid });
          }
        });
      });
      observer.observe({ type: 'first-input', buffered: true });
    } catch (e) {}
  }

  window.addEventListener('load', () => {
    setTimeout(() => {
      checkAccessibility();
      checkLayoutOverflow();
      setupFormUXTracking();
      reportIssues();
    }, 1000);
  });

  function reportIssues() {
    if (issues.length === 0) return;
    const payload = JSON.stringify({ path: window.location.pathname, issues: issues });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/seim/telemetry', payload);
    } else {
      fetch('/seim/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    }
  }
})();
`;
