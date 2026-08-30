import { createSign } from 'crypto';

export type GitHubTokenProvider = () => Promise<string>;

export interface GitHubAppAuthenticationOptions {
  appId: string | number;
  installationId: string | number;
  privateKey: string;
  apiBaseUrl?: string;
  apiVersion?: string;
}

/** Creates and refreshes short-lived GitHub App installation tokens without persisting them. */
export class GitHubAppTokenProvider {
  private token?: { value: string; expiresAt: number };
  private refreshing?: Promise<string>;
  private readonly baseUrl: string;
  constructor(private options: GitHubAppAuthenticationOptions) {
    if (!options.appId || !options.installationId || !options.privateKey) throw new Error('GitHub App authentication requires appId, installationId, and privateKey');
    this.baseUrl = (options.apiBaseUrl || 'https://api.github.com').replace(/\/$/, '');
  }

  public getToken = async (): Promise<string> => {
    if (this.token && this.token.expiresAt - Date.now() > 5 * 60 * 1000) return this.token.value;
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  };

  private async refresh(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/app/installations/${encodeURIComponent(String(this.options.installationId))}/access_tokens`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.jwt()}`,
        'X-GitHub-Api-Version': this.options.apiVersion || '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (!response.ok) throw new Error(`GitHub App token API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const data = await response.json() as any;
    if (typeof data.token !== 'string' || typeof data.expires_at !== 'string') throw new Error('GitHub App token response is incomplete');
    const expiresAt = Date.parse(data.expires_at);
    if (!Number.isFinite(expiresAt)) throw new Error('GitHub App token expiry is invalid');
    this.token = { value: data.token, expiresAt };
    return data.token;
  }

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(this.options.appId) }));
    const signingInput = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(this.options.privateKey.replace(/\\n/g, '\n')).toString('base64url');
    return `${signingInput}.${signature}`;
  }
}

export function staticGitHubToken(token: string): GitHubTokenProvider {
  if (!token) throw new Error('GitHub token is required');
  return async () => token;
}

function base64Url(value: string): string { return Buffer.from(value, 'utf8').toString('base64url'); }
