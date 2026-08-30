import { generateKeyPairSync, verify } from 'crypto';
import { GitHubAppTokenProvider } from '../src/github';

describe('GitHubAppTokenProvider', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('signs a short-lived app JWT and caches the installation token', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = jest.fn(async (input: any, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ token: 'ghs_1234567890_stateless_format', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }) as any;
    const provider = new GitHubAppTokenProvider({ appId: 'app-123', installationId: 456, privateKey: keys.privateKey, apiBaseUrl: 'https://github.example' });

    const [first, second] = await Promise.all([provider.getToken(), provider.getToken()]);
    expect(first).toBe('ghs_1234567890_stateless_format');
    expect(second).toBe(first);
    expect(await provider.getToken()).toBe(first);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://github.example/app/installations/456/access_tokens');

    const jwt = String((requests[0].init?.headers as Record<string, string>).Authorization).replace('Bearer ', '');
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({ alg: 'RS256' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims.iss).toBe('app-123');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });
});
