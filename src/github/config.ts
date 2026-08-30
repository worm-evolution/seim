import type { SeimConfig } from '../types';
import { GitHubAppTokenProvider, staticGitHubToken, type GitHubTokenProvider } from './auth';

export function githubTokenProvider(config: SeimConfig): GitHubTokenProvider {
  const github = config.engineer?.github;
  const token = github?.token || process.env.SEIM_GITHUB_TOKEN;
  if (token) return staticGitHubToken(token);
  const appId = github?.app?.appId || process.env.SEIM_GITHUB_APP_ID;
  const installationId = github?.app?.installationId || process.env.SEIM_GITHUB_INSTALLATION_ID;
  const privateKey = github?.app?.privateKey || process.env.SEIM_GITHUB_PRIVATE_KEY;
  if (!appId || !installationId || !privateKey) throw new Error('Configure a GitHub App installation or SEIM_GITHUB_TOKEN');
  return new GitHubAppTokenProvider({ appId, installationId, privateKey, apiBaseUrl: github?.apiBaseUrl }).getToken;
}
