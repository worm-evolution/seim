import { Request, Response, NextFunction, RequestHandler } from 'express';
import { SeimConfig } from './types';

export interface AuthConfig {
  enabled?: boolean;
  secret?: string;
  apiKey?: string;
  username?: string;
  password?: string;
}

/**
 * Creates an authentication guard middleware for SEIM Studio and control plane APIs.
 * Supports:
 * 1. Bearer Token (`Authorization: Bearer <token>`)
 * 2. API Key (`x-seim-key: <key>` or `x-api-key: <key>`)
 * 3. Basic Auth (`Authorization: Basic <base64>`)
 * 4. Environment variables (`SEIM_AUTH_SECRET`, `SEIM_API_KEY`, `SEIM_ADMIN_PASSWORD`)
 */
export function createAuthGuard(config?: SeimConfig): RequestHandler {
  const authConfig: AuthConfig = config?.auth || {};
  const isProd = config?.environment === 'production';
  const envSecret = process.env.SEIM_AUTH_SECRET || process.env.SEIM_API_KEY;
  const envPassword = process.env.SEIM_ADMIN_PASSWORD;

  const secret = authConfig.secret || authConfig.apiKey || envSecret;
  const username = authConfig.username || 'admin';
  const password = authConfig.password || envPassword;

  // Determine if authentication is active
  const isAuthRequired = isProd || authConfig.enabled === true || (authConfig.enabled !== false && (!!secret || !!password));

  return (req: Request, res: Response, next: NextFunction): void => {
    // If auth is not required, allow through
    if (!isAuthRequired) {
      return next();
    }

    // Fail closed when production has no configured credential. A reverse proxy can make an
    // external request appear to originate from localhost, so an IP/hostname exception is unsafe.
    if (!secret && !password) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'SEIM Studio authentication is not configured. Set `auth.secret`, `auth.password`, or the corresponding SEIM environment variable.',
      });
      return;
    }

    // Credentials are accepted only in headers. Query-string credentials leak through browser
    // history, referrers, access logs, and monitoring systems.
    const headerKey = req.headers['x-seim-key'] || req.headers['x-api-key'];
    if (secret && typeof headerKey === 'string' && safeEqual(headerKey, secret)) {
      return next();
    }

    // Check Authorization Header (Bearer or Basic)
    const authHeader = req.headers['authorization'];
    if (authHeader) {
      // Bearer token
      if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7).trim();
        if (secret && safeEqual(token, secret)) {
          return next();
        }
      }

      // Basic Auth
      if (authHeader.startsWith('Basic ')) {
        try {
          const b64 = authHeader.substring(6).trim();
          const decoded = Buffer.from(b64, 'base64').toString('utf8');
          const separator = decoded.indexOf(':');
          const u = separator >= 0 ? decoded.slice(0, separator) : '';
          const p = separator >= 0 ? decoded.slice(separator + 1) : '';
          if (password && u === username && safeEqual(p, password)) {
            return next();
          }
          if (secret && safeEqual(p, secret)) {
            return next();
          }
        } catch {
          // invalid base64
        }
      }
    }

    // If request asks for HTML (browser navigation), prompt with Basic Auth challenge
    const acceptsHtml = req.accepts ? req.accepts('html') : false;
    if (acceptsHtml && !(req.path || '').startsWith('/api/')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="SEIM Control Center"');
      res.status(401).send(`<!DOCTYPE html>
<html>
<head><title>401 Unauthorized - SEIM</title><style>body{font-family:monospace;background:#0c0c0e;color:#fff;padding:2rem;text-align:center;}</style></head>
<body>
  <h2>SEIM CONTROL CENTER &mdash; AUTHENTICATION REQUIRED</h2>
      <p style="color:#a1a1aa;">Provide valid credentials in the Authorization or x-seim-key header.</p>
</body>
</html>`);
      return;
    }

    // API requests receive JSON 401
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or missing credentials for SEIM Control Center API.',
    });
  };
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (actualBytes.length !== expectedBytes.length) return false;
  return require('crypto').timingSafeEqual(actualBytes, expectedBytes);
}
