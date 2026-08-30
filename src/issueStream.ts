import { BehaviorTracker, BehaviorPattern } from './behaviorTracker';
import { InMemoryMetricsStore } from './metrics';
import { SeimConfig } from './types';
import { SeimEventBus } from './events';
import { Logger } from './logger';
import { IntentAnalyzer } from './intentAnalyzer';
import { LLMClient } from './ai';

export type IssueType =
  | 'bug:5xx_spike'
  | 'bug:error_pattern'
  | 'ux:navigation_loop'
  | 'ux:rage_click'
  | 'ux:drop_off'
  | 'feature:missing_api'
  | 'feature:missing_page'
  | 'perf:slow_endpoint'
  | 'perf:high_demand';

export interface ProductIssue {
  id: string;
  type: IssueType;
  path: string;
  method?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  frequency: number;
  affectedSessions: number;
  evidence: any[];
  suggestedAction: string;
  detectedAt: number;
  updatedAt: number;
  status: 'open' | 'in_progress' | 'resolved' | 'dismissed';
  intentMetadata?: Record<string, any>;
}

export class IssueStream {
  private issues: Map<string, ProductIssue> = new Map();
  private checkTimer: NodeJS.Timeout | null = null;
  private intentAnalyzer?: IntentAnalyzer;
  private readonly BLOCKED_PATTERNS = [
    /\.env/i,
    /wp-admin/i,
    /wp-login/i,
    /phpinfo/i,
    /\.git/i,
    /eval\(/i,
    /\.(php|asp|aspx|jsp|cgi)$/i,
    /select.*from/i,
    /union.*select/i,
    /<script/i,
    /\.\.\//,
  ];

  constructor(
    private tracker: BehaviorTracker,
    private metrics: InMemoryMetricsStore,
    private config: SeimConfig,
    private events: SeimEventBus,
    private logger: Logger,
    intentAnalyzer?: IntentAnalyzer,
  ) {
    if (intentAnalyzer) {
      this.intentAnalyzer = intentAnalyzer;
    } else if (config.ai?.apiKey) {
      this.intentAnalyzer = new IntentAnalyzer(config, new LLMClient(config), logger);
    }
  }

  public start(): void {
    const interval = this.config.behavior?.issueCheckIntervalMs || 60000;
    this.checkTimer = setInterval(() => {
      try {
        this.scanAndEmit();
      } catch (err: any) {
        this.logger.warn('[IssueStream] Scan failed', { error: err?.message });
      }
    }, interval);

    if (this.checkTimer && typeof this.checkTimer.unref === 'function') {
      this.checkTimer.unref();
    }
  }

  public scanAndEmit(): ProductIssue[] {
    const detected: ProductIssue[] = [];
    const minSessions = this.config.behavior?.minIssueSessionThreshold || 3;

    // 1. Scan 404s for Missing Features (Sybil & probe filtered)
    const missing = this.tracker.getMissingFeatures(this.config.behavior?.minPatternFrequency || 3);
    for (const m of missing) {
      if (this.isBlocked(m.path)) continue;
      if (m.sessions < minSessions) continue;

      const isApi = m.path.startsWith('/api/') || m.path.startsWith('/v1/') || m.path.startsWith('/v2/');
      const type: IssueType = isApi ? 'feature:missing_api' : 'feature:missing_page';
      const id = `issue_${type}_${m.method}_${m.path}`;

      const issue: ProductIssue = {
        id,
        type,
        path: m.path,
        method: m.method,
        severity: m.sessions >= 10 ? 'high' : 'medium',
        frequency: m.count,
        affectedSessions: m.sessions,
        evidence: [{ count: m.count, sessions: m.sessions }],
        suggestedAction: `Implement missing ${m.method} endpoint on ${m.path} requested by ${m.sessions} distinct visitor sessions`,
        detectedAt: Date.now(),
        updatedAt: Date.now(),
        status: 'open',
      };
      this.upsert(issue, detected);
    }

    // 2. Scan for 5xx Error Spikes (Bug Detection)
    const snapshot = this.metrics.snapshot();
    for (const [routeKey, r] of Object.entries(snapshot.routes)) {
      if (r.requestCount >= 10) {
        const errorRate = r.errorCount / r.requestCount;
        if (errorRate >= 0.05 || r.timeoutCount > 2) {
          const id = `issue_bug_5xx_${routeKey}`;
          const issue: ProductIssue = {
            id,
            type: 'bug:5xx_spike',
            path: routeKey,
            severity: errorRate > 0.2 ? 'critical' : 'high',
            frequency: r.errorCount,
            affectedSessions: r.errorCount,
            evidence: [{ errorRate, errorCount: r.errorCount, totalRequests: r.requestCount, timeouts: r.timeoutCount }],
            suggestedAction: `Diagnose and fix runtime exceptions on ${routeKey} (${Math.round(errorRate * 100)}% error rate)`,
            detectedAt: Date.now(),
            updatedAt: Date.now(),
            status: 'open',
          };
          this.upsert(issue, detected);
        }
      }
    }

    // 3. Scan for UX Navigation Loops & Drop-offs
    const patterns = this.tracker.analyze();
    for (const p of patterns) {
      if (this.isBlocked(p.path)) continue;
      if (p.affectedSessions < minSessions) continue;

      if (p.type === 'navigation_loop' || p.type === 'drop_off') {
        const id = `issue_ux_${p.type}_${p.path}`;
        const issue: ProductIssue = {
          id,
          type: p.type === 'navigation_loop' ? 'ux:navigation_loop' : 'ux:drop_off',
          path: p.path,
          severity: 'medium',
          frequency: p.frequency,
          affectedSessions: p.affectedSessions,
          evidence: p.evidence,
          suggestedAction: p.type === 'navigation_loop'
            ? `Resolve circular navigation loop around ${p.path}`
            : `Streamline user journey on drop-off bottleneck ${p.path}`,
          detectedAt: p.firstSeenAt,
          updatedAt: p.lastSeenAt,
          status: 'open',
        };
        this.upsert(issue, detected);
      }
    }

    return detected;
  }

  public isBlocked(path: string): boolean {
    return this.BLOCKED_PATTERNS.some(re => re.test(path));
  }

  private upsert(issue: ProductIssue, detected: ProductIssue[]): void {
    const existing = this.issues.get(issue.id);
    if (!existing) {
      this.issues.set(issue.id, issue);
      detected.push(issue);
      this.events.emitEvent('issue:detected', issue);
    } else if (existing.status === 'open') {
      existing.frequency = issue.frequency;
      existing.affectedSessions = issue.affectedSessions;
      existing.updatedAt = Date.now();
      existing.evidence = issue.evidence;
    }
  }

  public getOpenIssues(): ProductIssue[] {
    return Array.from(this.issues.values()).filter(i => i.status === 'open');
  }

  public getAllIssues(): ProductIssue[] {
    return Array.from(this.issues.values());
  }

  public resolveIssue(issueId: string): void {
    const issue = this.issues.get(issueId);
    if (issue) {
      issue.status = 'resolved';
      issue.updatedAt = Date.now();
      this.events.emitEvent('issue:resolved', issue);
    }
  }

  public dismissIssue(issueId: string): void {
    const issue = this.issues.get(issueId);
    if (issue) {
      issue.status = 'dismissed';
      issue.updatedAt = Date.now();
      this.events.emitEvent('issue:dismissed', issue);
    }
  }

  public destroy(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.issues.clear();
  }
}
