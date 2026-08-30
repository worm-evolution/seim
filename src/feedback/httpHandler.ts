import type { Request, RequestHandler, Response } from 'express';
import { FeedbackHttpError, GitHubFeedbackLoop } from './githubFeedbackLoop';

/** Mount with express.raw({ type: 'application/json', limit: '1mb' }) before express.json(). */
export function createGitHubFeedbackHandler(loop: GitHubFeedbackLoop): RequestHandler {
  return async (request: Request, response: Response): Promise<void> => {
    try {
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.isBuffer((request as any).rawBody) ? (request as any).rawBody : undefined;
      if (!rawBody) throw new FeedbackHttpError(400, 'Raw webhook body is required for signature verification');
      const event = header(request, 'x-github-event');
      const delivery = header(request, 'x-github-delivery');
      const signature = header(request, 'x-hub-signature-256');
      if (!event || !delivery) throw new FeedbackHttpError(400, 'GitHub event and delivery headers are required');
      const result = await loop.handle(event, delivery, signature, rawBody);
      response.status(result.duplicate ? 202 : 200).json({ ok: true, duplicate: result.duplicate === true, status: result.record.status, reason: result.record.reason });
    } catch (error) {
      const status = error instanceof FeedbackHttpError ? error.statusCode : 500;
      response.status(status).json({ ok: false, error: error instanceof FeedbackHttpError ? error.message : 'Webhook processing failed' });
    }
  };
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
