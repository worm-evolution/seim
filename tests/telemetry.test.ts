import { createListener, frontendOverrides, SENSOR_CODE } from '../src/middleware';
import { SeimConfig } from '../src/types';

describe('Frontend Telemetry & Overrides', () => {
  let config: SeimConfig;
  let deps: any;

  beforeEach(() => {
    frontendOverrides.clear();
    config = {
      mode: 'bypass',
      studioPath: '/studio',
      businessRules: [],
      securityRules: [],
      ai: { enabled: false, generatorModel: '', reviewerModel: '', verifierModel: '' },
      experiment: {
        confidenceThreshold: 0.9,
        canaryPercent: 100,
        rollbackLatencyMultiplier: 1.2,
        rollbackErrorRate: 1.5,
        minSampleSize: 5,
        shadowCooldownMs: 1000,
        shadowAllowedMethods: ['GET'],
        shadowSampleSize: 5,
      },
      storage: { type: 'memory' },
      security: {
        blockAuthenticationChanges: true,
        blockAuthorizationChanges: true,
        blockPaymentChanges: true,
        blockSecretUsage: true,
        allowedPatternModels: ['sequential-async'],
      },
      learning: { enabled: true, sampleSize: 5 },
    };

    deps = {
      adapter: {
        createMiddleware: jest.fn().mockImplementation((onRequest, onResponse) => {
          return (req: any, res: any, next: any) => { next(); };
        }),
      },
      events: { emitEvent: jest.fn() },
      logger: { info: jest.fn(), warn: jest.fn() },
      worker: { setProcessor: jest.fn() },
      optimization: {
        llm: {
          generateFrontendOverrides: jest.fn().mockResolvedValue({
            css: '#overflow-el { max-width: 100%; }',
            js: 'console.log("Fixed accessibility");',
          }),
        },
      },
    };
  });

  it('should serve the sensor script on GET /seim/sensor.js', async () => {
    const listener = createListener(config, deps)();
    const req = { path: '/seim/sensor.js' } as any;
    const res = {
      setHeader: jest.fn(),
      send: jest.fn(),
    } as any;
    const next = jest.fn();

    await listener(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/javascript');
    expect(res.send).toHaveBeenCalledWith(SENSOR_CODE);
    expect(next).not.toHaveBeenCalled();
  });

  it('should accept telemetry and generate frontend overrides', async () => {
    const listener = createListener(config, deps)();
    const req = {
      path: '/seim/telemetry',
      method: 'POST',
      body: {
        path: '/dashboard',
        issues: [
          { type: 'layout', selector: '#overflow-el', message: 'Element overflows horizontally' },
        ],
      },
    } as any;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    } as any;

    await listener(req, res, jest.fn());

    // Allow async optimizeFrontendForTelemetry to run
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(res.status).toHaveBeenCalledWith(200);
    expect(frontendOverrides.has('/dashboard')).toBe(true);
    expect(frontendOverrides.get('/dashboard')).toEqual({
      css: '#overflow-el { max-width: 100%; }',
      js: '',
    });
  });

  it('should inject only CSS overrides and the sensor script into HTML responses', async () => {
    // Populate overrides cache first
    frontendOverrides.set('/home', {
      css: '.card { overflow: hidden; }',
      js: 'console.log("override js");',
    });

    const listener = createListener(config, deps)();
    const req = { path: '/home' } as any;
    
    let responseBody = '';
    const res = {
      getHeader: jest.fn().mockReturnValue('text/html'),
      send: jest.fn().mockImplementation((body) => {
        responseBody = body;
      }),
    } as any;

    await listener(req, res, () => {
      // Inside middleware execution, call res.send to trigger wrapper
      res.send('<html><head></head><body><h1>Hello World</h1></body></html>');
    });

    expect(responseBody).toContain('<style id="seim-overrides">.card { overflow: hidden; }</style>');
    expect(responseBody).not.toContain('seim-js-overrides');
    expect(responseBody).not.toContain('override js');
    expect(responseBody).toContain('<script src="/seim/sensor.js" defer></script>');
  });

  it('should instrument streamed HTML responses used by static files', async () => {
    const listener = createListener(config, deps)();
    const req = { path: '/', method: 'GET' } as any;
    let responseBody = Buffer.alloc(0);
    const res = {
      getHeader: jest.fn().mockReturnValue('text/html; charset=utf-8'),
      removeHeader: jest.fn(),
      write: jest.fn().mockImplementation((chunk: any) => {
        responseBody = Buffer.concat([responseBody, Buffer.from(chunk)]);
        return true;
      }),
      end: jest.fn().mockImplementation((chunk?: any) => {
        if (chunk) responseBody = Buffer.concat([responseBody, Buffer.from(chunk)]);
      }),
      send: jest.fn(),
    } as any;

    await listener(req, res, () => {
      res.write('<html><head><title>App</title></head><body>');
      res.end('<main>Static app</main></body></html>');
    });

    const html = responseBody.toString('utf8');
    expect(html).toContain('<main>Static app</main>');
    expect(html).toContain('<script src="/seim/sensor.js" defer></script>');
    expect(res.removeHeader).toHaveBeenCalledWith('content-length');
  });
});
