import { Request, Response, RequestHandler } from 'express';
import { SeimInstance } from './types';
import { createAuthGuard } from './auth';
import { handleEngineerApi } from './studio/engineerApi';

// Internal event ring-buffer per studio handler
const studioEventLog: Array<{ ts: number; event: string; payload: any }> = [];
const MAX_EVENTS = 100;

/** Push an event into the studio event ring buffer (called from index.ts) */
export function pushStudioEvent(event: string, payload: any): void {
  studioEventLog.push({ ts: Date.now(), event, payload: sanitizeStudioPayload(payload) });
  if (studioEventLog.length > MAX_EVENTS) studioEventLog.shift();
}

/**
 * Create a studio dashboard handler.
 *
 * IMPORTANT: The returned handler closes over the `instance` object by reference.
 * As long as the caller mutates the same object (not reassigns), all API endpoints
 * will automatically see the fully-initialised instance — even if `app.use()` was
 * called before `index.ts` finished wiring everything in.
 */
export function createStudioHandler(instance: SeimInstance): RequestHandler {
  const authGuard = createAuthGuard(instance.config);

  return async (req: Request, res: Response, next?: any): Promise<void> => {
    let isAuthorized = false;
    authGuard(req, res, () => { isAuthorized = true; });
    if (!isAuthorized) {
      return;
    }

    if (isMutation(req) && !isSameOriginRequest(req)) {
      res.status(403).json({ success: false, error: 'Cross-origin Studio mutations are not allowed' });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const p = req.path || req.url || '';
    if (p.endsWith('/api/status') || p.endsWith('/status')) {
      const statusData = instance && typeof instance.status === 'function' ? instance.status() : {};
      res.json({ ok: true, status: statusData, ...statusData });
      return;
    }
    if (p.endsWith('/api/metrics') || p.endsWith('/metrics')) {
      res.json(instance?.metrics ? instance.metrics.snapshot() : {});
      return;
    }
    if (p.endsWith('/api/candidates')) {
      const store = instance?.candidateStore;
      if (!store) { res.json([]); return; }
      Promise.resolve(store.listAll ? store.listAll() : []).then((list: any[]) => {
        res.json(list);
      }).catch(() => res.json([]));
      return;
    }
    if (p.endsWith('/api/behavior')) {
      const snapshot = instance?.behaviorTracker ? instance.behaviorTracker.snapshot() : {};
      const components = instance?.reactRegistry ? instance.reactRegistry.listAll() : [];
      res.json({ ...snapshot, components });
      return;
    }
    if (p.endsWith('/api/changelog')) {
      const entries = instance?.changelog ? instance.changelog.getRecent(100) : [];
      res.json(entries);
      return;
    }
    if (p.endsWith('/api/issues')) {
      const openIssues = instance?.issueStream ? instance.issueStream.getOpenIssues() : [];
      const allIssues = instance?.issueStream ? instance.issueStream.getAllIssues() : [];
      res.json({ open: openIssues, all: allIssues });
      return;
    }
    if (p.includes('/api/engineer/') && await handleEngineerApi(req, res, instance)) {
      return;
    }
    if (p.endsWith('/api/pull-requests')) {
      const prs = instance?.prGenerator ? instance.prGenerator.listAll() : [];
      res.json(prs);
      return;
    }
    if (p.endsWith('/api/create-pr') && req.method === 'POST') {
      const body = req.body || {};
      const { issueId, routeKey, code } = body;
      if (instance?.prGenerator) {
        if (issueId && instance?.issueStream) {
          const issue = instance.issueStream.getAllIssues().find((i: any) => i.id === issueId);
          if (issue) {
            const generatedCode = code || (instance?.scaffolder ? await instance.scaffolder.scaffoldRoute(issue.method || 'GET', issue.path, issue.suggestedAction) : '// Scaffolded route');
            const pr = await instance.prGenerator.createPrFromIssue(issue, generatedCode);
            res.json({ success: true, pr });
            return;
          }
        } else if (routeKey) {
          const pr = await instance.prGenerator.createPrFromOptimization(
            routeKey,
            body.originalCode || '',
            body.optimizedCode || code || '',
            body.latencyImprovement || '50ms'
          );
          res.json({ success: true, pr });
          return;
        }
      }
      res.status(400).json({ success: false, error: 'Could not create PR. Ensure issueId or routeKey is provided.' });
      return;
    }
    if (p.endsWith('/api/merge-pr') && req.method === 'POST') {
      res.status(410).json({ success: false, error: 'Legacy in-memory PR merging is disabled. Use the authenticated engineer control-plane merge workflow.' });
      return;
    }
    if (p.endsWith('/api/evolve-issue') && req.method === 'POST') {
      const body = req.body || {};
      const issueId = body.issueId;
      if (instance?.orchestrator && instance?.issueStream && issueId) {
        const issue = instance.issueStream.getAllIssues().find((i: any) => i.id === issueId);
        if (issue) {
          instance.orchestrator.handleIssue(issue).then((ok: boolean) => {
            res.json({ success: ok, message: ok ? 'Issue evolved & deployed successfully' : 'Evolution could not be completed' });
          }).catch((err: any) => {
            res.status(500).json({ success: false, error: err.message });
          });
          return;
        }
      }
      res.status(400).json({ success: false, error: 'Issue not found or orchestrator unavailable' });
      return;
    }
    if (p.endsWith('/api/dismiss-issue') && req.method === 'POST') {
      const body = req.body || {};
      const issueId = body.issueId;
      if (instance?.issueStream && issueId) {
        instance.issueStream.dismissIssue(issueId);
        res.json({ success: true, message: 'Issue dismissed' });
        return;
      }
      res.status(400).json({ success: false, error: 'issueId required' });
      return;
    }
    if (p.endsWith('/api/events')) {
      res.json(studioEventLog);
      return;
    }
    if (p.endsWith('/api/rollback') || p.endsWith('/rollback')) {
      if (req.method === 'POST') {
        const body = req.body || {};
        const routeKey = body.routeKey || body.route;
        const reason = body.reason || 'Manual rollback via Studio';
        if (!routeKey) {
          res.status(400).json({ success: false, error: 'routeKey is required' });
          return;
        }
        let success = false;
        if (instance?.dispatcher) {
          success = instance.dispatcher.rollback(routeKey, reason);
        } else if (instance?.dynamicRouter) {
          instance.dynamicRouter.swapHandler(routeKey, null as any, 'optimized');
          success = true;
        }
        res.json({ success, routeKey, message: success ? 'Rollback successful' : 'Route not found or rollback failed' });
        return;
      }
    }
    if (p.endsWith('/api/promote') && req.method === 'POST') {
      const body = req.body || {};
      const routeKey = body.routeKey || body.route;
      let success = false;
      if (instance?.dispatcher && routeKey) {
        success = instance.dispatcher.promote(routeKey);
      }
      res.json({ success, routeKey, message: success ? 'Candidate promoted to production' : 'Promotion failed' });
      return;
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SEIM CONTROL CENTER</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=Inter:wght@400;600;700;900&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0c0c0e;
      --card-bg: #141418;
      --card-border: #ffffff;
      --border: #ffffff;
      --text: #f4f4f5;
      --text-muted: #a1a1aa;
      --maroon: #800020;
      --maroon-accent: #e11d48;
      --accent: #38bdf8;
      --accent-green: #4ade80;
      --accent-amber: #fbbf24;
      --accent-rose: #f87171;
      --shadow: 4px 4px 0px #000000;
      --btn-shadow: 3px 3px 0px #ffffff;
    }

    [data-theme="light"] {
      --bg: #fcf9f5;
      --card-bg: #ffffff;
      --card-border: #111111;
      --border: #111111;
      --text: #111111;
      --text-muted: #52525b;
      --maroon: #800020;
      --maroon-accent: #800020;
      --accent: #800020;
      --accent-green: #15803d;
      --accent-amber: #b45309;
      --accent-rose: #b91c1c;
      --shadow: 4px 4px 0px #800020;
      --btn-shadow: 3px 3px 0px #111111;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      transition: background 0.15s ease, color 0.15s ease;
    }

    header {
      background: var(--card-bg);
      border-bottom: 3px solid var(--border);
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .logo-box {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .logo-badge {
      background: var(--maroon);
      color: #ffffff;
      font-family: 'Space Mono', monospace;
      font-weight: 700;
      font-size: 1.25rem;
      padding: 0.35rem 0.75rem;
      border: 2px solid var(--border);
      box-shadow: var(--btn-shadow);
      letter-spacing: 1px;
    }
    .logo-title {
      font-size: 1.1rem;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .btn {
      font-family: 'Space Mono', monospace;
      font-weight: 700;
      font-size: 0.82rem;
      text-transform: uppercase;
      padding: 0.45rem 0.9rem;
      background: var(--card-bg);
      color: var(--text);
      border: 2px solid var(--border);
      box-shadow: var(--btn-shadow);
      cursor: pointer;
      border-radius: 0px;
      transition: all 0.08s ease;
    }
    .btn:hover {
      transform: translate(-1px, -1px);
      box-shadow: 4px 4px 0px var(--border);
    }
    .btn:active {
      transform: translate(2px, 2px);
      box-shadow: 1px 1px 0px var(--border);
    }

    .btn-maroon {
      background: var(--maroon);
      color: #ffffff;
      border-color: var(--border);
    }
    .btn-green {
      background: var(--accent-green);
      color: #000000;
      border-color: var(--border);
    }
    .btn-rose {
      background: var(--accent-rose);
      color: #ffffff;
      border-color: var(--border);
    }

    main {
      flex: 1;
      padding: 2rem;
      max-width: 1400px;
      margin: 0 auto;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 2rem;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1.25rem;
    }

    .card {
      background: var(--card-bg);
      border: 2px solid var(--border);
      box-shadow: var(--shadow);
      padding: 1.25rem;
      border-radius: 0px;
      position: relative;
    }
    .card-title {
      font-family: 'Space Mono', monospace;
      font-size: 0.78rem;
      text-transform: uppercase;
      font-weight: 700;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
    }
    .card-value {
      font-family: 'Space Mono', monospace;
      font-size: 1.85rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
    }
    .card-subtext {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .nav-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      border-bottom: 3px solid var(--border);
      padding-bottom: 0.75rem;
    }
    .tab-btn {
      font-family: 'Space Mono', monospace;
      font-size: 0.85rem;
      font-weight: 700;
      text-transform: uppercase;
      padding: 0.55rem 1rem;
      background: var(--card-bg);
      color: var(--text);
      border: 2px solid var(--border);
      box-shadow: var(--btn-shadow);
      cursor: pointer;
      border-radius: 0px;
      transition: all 0.08s ease;
    }
    .tab-btn:hover {
      transform: translate(-1px, -1px);
      box-shadow: 4px 4px 0px var(--border);
    }
    .tab-btn.active {
      background: var(--maroon);
      color: #ffffff;
      border-color: var(--border);
      transform: translate(2px, 2px);
      box-shadow: 1px 1px 0px var(--border);
    }

    .tab-content { display: none; }
    .tab-content.active { display: block; }

    .table-container {
      background: var(--card-bg);
      border: 2px solid var(--border);
      box-shadow: var(--shadow);
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.9rem;
    }
    th {
      font-family: 'Space Mono', monospace;
      font-size: 0.8rem;
      text-transform: uppercase;
      background: var(--card-bg);
      border-bottom: 2px solid var(--border);
      padding: 0.85rem 1.25rem;
      font-weight: 700;
    }
    td {
      padding: 0.85rem 1.25rem;
      border-bottom: 1px solid var(--border);
      font-family: 'Inter', sans-serif;
    }
    tr:last-child td { border-bottom: none; }

    .tag {
      font-family: 'Space Mono', monospace;
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      padding: 0.2rem 0.5rem;
      border: 1px solid var(--border);
      display: inline-block;
    }
    .tag-maroon { background: var(--maroon); color: #ffffff; }
    .tag-green { background: var(--accent-green); color: #000000; }
    .tag-amber { background: var(--accent-amber); color: #000000; }
    .tag-rose { background: var(--accent-rose); color: #ffffff; }

    pre {
      font-family: 'Space Mono', monospace;
      font-size: 0.85rem;
      background: var(--bg);
      color: var(--text);
      padding: 1rem;
      border: 2px solid var(--border);
      overflow-x: auto;
    }
  </style>
</head>
<body>
  <header>
    <div class="logo-box">
      <div class="logo-badge">SEIM</div>
      <div class="logo-title">Control Center</div>
    </div>
    <div class="header-actions">
      <span class="tag tag-maroon" id="val-mode">MODE: ${instance.config.mode.toUpperCase()}</span>
      <button class="btn" id="theme-toggle-btn" onclick="toggleTheme()">[ THEME: LIGHT ]</button>
    </div>
  </header>

  <main>
    <!-- Metric Cards -->
    <div class="stats-grid">
      <div class="card">
        <div class="card-title">OPERATIONAL STATUS</div>
        <div class="card-value" style="color: var(--accent-green);" id="val-health">HEALTHY</div>
        <div class="card-subtext">Framework: ${instance.config.framework || 'express'}</div>
      </div>
      <div class="card">
        <div class="card-title">SHIPPED EVOLUTIONS</div>
        <div class="card-value" style="color: var(--maroon-accent);" id="val-shipped-count">0</div>
        <div class="card-subtext">Autonomously deployed</div>
      </div>
      <div class="card">
        <div class="card-title">OPEN PR PROPOSALS</div>
        <div class="card-value" style="color: var(--accent-amber);" id="val-pr-count">0</div>
      <div class="card-subtext">Awaiting review and delivery policy</div>
      </div>
      <div class="card">
        <div class="card-title">SAFETY ROLLBACKS</div>
        <div class="card-value" style="color: var(--accent-rose);" id="val-rollbacks">0</div>
        <div class="card-subtext">Automated regression sentry</div>
      </div>
    </div>

    <!-- Navigation Tabs -->
    <div class="nav-tabs" role="tablist" aria-label="SEIM control center sections">
      <button class="tab-btn active" role="tab" aria-selected="true" aria-controls="tab-shipped" onclick="switchTab('shipped', this)">[ SHIPPED EVOLUTION ]</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-prs" onclick="switchTab('prs', this)">[ PULL REQUESTS ]</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-issues" onclick="switchTab('issues', this)">[ ISSUE STREAM ]</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-overview" onclick="switchTab('overview', this)">[ ROUTE TELEMETRY ]</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-optimizations" onclick="switchTab('optimizations', this)">[ CANDIDATES & DIFFS ]</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-behavior" onclick="switchTab('behavior', this)">[ VISITOR BEHAVIOR ]</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-events" onclick="switchTab('events', this)">[ LIVE EVENTS ]</button>
      <button class="tab-btn" role="tab" aria-selected="false" aria-controls="tab-developer" onclick="switchTab('developer', this)">[ RAW STATE ]</button>
    </div>

    <!-- Tab 1: Shipped Evolution Timeline -->
    <div id="tab-shipped" class="tab-content active" role="tabpanel" tabindex="0">
      <div class="card">
        <div class="card-title" style="color: var(--text);">PRODUCT EVOLUTION TIMELINE</div>
        <div id="changelog-list" style="display: flex; flex-direction: column; gap: 1rem; margin-top: 1rem;">
          <div style="color: var(--text-muted); font-size: 0.85rem;">No autonomous changes recorded yet. Real-time visitor activity will trigger evolution.</div>
        </div>
      </div>
    </div>

    <!-- Tab 2: Staging PRs -->
    <div id="tab-prs" class="tab-content" role="tabpanel" tabindex="0">
      <div class="card">
        <div class="card-title" style="color: var(--text);">TELEMETRY-DRIVEN PULL REQUESTS & STAGING BRANCHES</div>
        <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem; margin-bottom: 1rem;">
          SEIM identifies real visitor demand, writes clean production-grade code to a staging branch, and opens a Pull Request for 1-click approval.
        </div>
        <div id="prs-list" style="display: flex; flex-direction: column; gap: 1rem;">
          <div style="color: var(--text-muted); font-size: 0.85rem;">No open pull requests generated. Click [GENERATE PR] on any detected issue or candidate below.</div>
        </div>
      </div>
    </div>

    <!-- Tab 3: Issue Stream -->
    <div id="tab-issues" class="tab-content" role="tabpanel" tabindex="0">
      <div class="card">
        <div class="card-title" style="color: var(--text);">DETECTED ISSUES & FEATURE OPPORTUNITIES</div>
        <div id="issues-list" style="display: flex; flex-direction: column; gap: 1rem; margin-top: 1rem;">
          <div style="color: var(--text-muted); font-size: 0.85rem;">No open issues detected across active visitor sessions. All systems healthy.</div>
        </div>
      </div>
    </div>

    <!-- Tab 4: Route Telemetry -->
    <div id="tab-overview" class="tab-content" role="tabpanel" tabindex="0">
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>ENDPOINT</th>
              <th>VOLUME</th>
              <th>AVG LATENCY</th>
              <th>ACTIVE VERSION</th>
              <th>STATUS</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody id="routes-tbody">
            <tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">Listening for incoming traffic...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab 5: Candidate Diffs -->
    <div id="tab-optimizations" class="tab-content" role="tabpanel" tabindex="0">
      <div class="card">
        <div class="card-title" style="color: var(--text);">EVOLUTION & SANDBOXED CANDIDATES</div>
        <div id="candidates-list" style="display: grid; gap: 1rem; margin-top: 1rem;">
          <div style="color: var(--text-muted); font-size: 0.85rem;">No active evolution candidates in storage.</div>
        </div>
      </div>
    </div>

    <!-- Tab 6: Visitor Behavior & React -->
    <div id="tab-behavior" class="tab-content" role="tabpanel" tabindex="0">
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem;">
        <div class="card">
          <div class="card-title">VISITOR PATTERNS (404S & HOT PATHS)</div>
          <div id="behavior-patterns" style="margin-top: 1rem; display: grid; gap: 0.75rem; font-size: 0.85rem;">
            <div style="color: var(--text-muted);">Tracking user journeys...</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">SCAFFOLDED REACT TSX COMPONENTS</div>
          <div id="react-components-list" style="margin-top: 1rem; display: grid; gap: 0.75rem; font-size: 0.85rem;">
            <div style="color: var(--text-muted);">No React frontend components scaffolded yet.</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Tab 7: Live Events -->
    <div id="tab-events" class="tab-content" role="tabpanel" tabindex="0">
      <div class="card">
        <div class="card-title">REAL-TIME LIFECYCLE EVENT STREAM</div>
        <div id="events-log" style="display: flex; flex-direction: column; gap: 0.5rem; font-size: 0.82rem; font-family: 'Space Mono', monospace; max-height: 450px; overflow-y: auto; margin-top: 1rem;">
          <div style="color: var(--text-muted);">Waiting for events...</div>
        </div>
      </div>
    </div>

    <!-- Tab 8: Raw State -->
    <div id="tab-developer" class="tab-content" role="tabpanel" tabindex="0">
      <pre id="json-viewer">Loading state...</pre>
    </div>
  </main>

  <!-- Diff & PR Modal -->
  <div id="diff-modal" role="dialog" aria-modal="true" aria-labelledby="diff-modal-title" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 100; align-items: center; justify-content: center; padding: 2rem;">
    <div tabindex="-1" style="background: var(--card-bg); border: 3px solid var(--border); box-shadow: var(--shadow); width: 100%; max-width: 900px; max-height: 85vh; display: flex; flex-direction: column;">
      <div style="padding: 1rem 1.5rem; border-bottom: 2px solid var(--border); display: flex; justify-content: space-between; align-items: center;">
        <div id="diff-modal-title" style="font-family: 'Space Mono', monospace; font-size: 1rem; font-weight: 700; text-transform: uppercase;">CODE INSPECTION</div>
        <button onclick="closeDiffModal()" class="btn">[ CLOSE ]</button>
      </div>
      <div id="diff-modal-body" style="padding: 1.5rem; overflow-y: auto; flex: 1;">
        <pre id="diff-code-view" style="white-space: pre-wrap;"></pre>
      </div>
    </div>
  </div>

  <script>
    const studioPath = "${instance.config.studioPath || '/seim'}";
    let currentTheme = localStorage.getItem('seim_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', currentTheme);
    updateThemeButton();

    window._studioModalData = new Map();

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function toggleTheme() {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', currentTheme);
      localStorage.setItem('seim_theme', currentTheme);
      updateThemeButton();
    }

    function updateThemeButton() {
      const btn = document.getElementById('theme-toggle-btn');
      if (btn) {
        btn.textContent = currentTheme === 'dark' ? '[ THEME: LIGHT ]' : '[ THEME: DARK ]';
      }
    }

    function switchTab(tabName, selectedButton) {
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      if (!selectedButton) return;
      selectedButton.classList.add('active');
      selectedButton.setAttribute('aria-selected', 'true');
      const panel = document.getElementById('tab-' + tabName);
      if (panel) panel.classList.add('active');
    }

    function showStoredModal(id) {
      const data = window._studioModalData.get(id);
      if (data) {
        document.getElementById('diff-modal-title').textContent = data.title;
        document.getElementById('diff-code-view').textContent = data.code;
        document.getElementById('diff-modal').style.display = 'flex';
      }
    }

    function closeDiffModal() {
      document.getElementById('diff-modal').style.display = 'none';
    }

    async function triggerCreatePr(issueId, routeKey) {
      try {
        const res = await fetch(studioPath + '/api/create-pr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ issueId, routeKey })
        }).then(r => r.json());
        alert(res.success ? 'Pull Request #' + res.pr.number + ' generated on staging branch ' + res.pr.branchName : 'Failed to generate PR: ' + res.error);
        updateDashboard();
      } catch (err) {
        alert('PR Generation error: ' + err.message);
      }
    }

    async function triggerMergePr(prId) {
      if (!confirm('Approve and merge ' + prId + ' to production?')) return;
      try {
        const res = await fetch(studioPath + '/api/merge-pr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prId })
        }).then(r => r.json());
        alert(res.message || (res.success ? 'PR Merged and deployed!' : 'Merge failed'));
        updateDashboard();
      } catch (err) {
        alert('Merge error: ' + err.message);
      }
    }

    async function triggerRollback(routeKey) {
      if (!confirm('Rollback ' + routeKey + ' to original version?')) return;
      try {
        const res = await fetch(studioPath + '/api/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ routeKey, reason: 'Manual Studio rollback' })
        }).then(r => r.json());
        alert(res.message || (res.success ? 'Rollback completed.' : 'Rollback failed.'));
        updateDashboard();
      } catch (err) {
        alert('Rollback error: ' + err.message);
      }
    }

    async function triggerPromote(routeKey) {
      if (!confirm('Promote candidate for ' + routeKey + ' to 100% production traffic?')) return;
      try {
        const res = await fetch(studioPath + '/api/promote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ routeKey })
        }).then(r => r.json());
        alert(res.message || (res.success ? 'Candidate promoted.' : 'Promotion failed.'));
        updateDashboard();
      } catch (err) {
        alert('Promote error: ' + err.message);
      }
    }

    async function triggerEvolveIssue(issueId) {
      try {
        const res = await fetch(studioPath + '/api/evolve-issue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ issueId })
        }).then(r => r.json());
        alert(res.message || (res.success ? 'Issue evolved & deployed.' : 'Evolution failed: ' + res.error));
        updateDashboard();
      } catch (err) {
        alert('Evolve error: ' + err.message);
      }
    }

    async function triggerDismissIssue(issueId) {
      try {
        await fetch(studioPath + '/api/dismiss-issue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ issueId })
        });
        updateDashboard();
      } catch (err) {
        alert('Dismiss error: ' + err.message);
      }
    }

    async function updateDashboard() {
      try {
        const [statusRes, metricsRes, candidatesRes, behaviorRes, eventsRes, changelogRes, issuesRes, prsRes] = await Promise.all([
          fetch(studioPath + '/api/status').then(r => r.json()).catch(() => ({})),
          fetch(studioPath + '/api/metrics').then(r => r.json()).catch(() => ({})),
          fetch(studioPath + '/api/candidates').then(r => r.json()).catch(() => ([])),
          fetch(studioPath + '/api/behavior').then(r => r.json()).catch(() => ({})),
          fetch(studioPath + '/api/events').then(r => r.json()).catch(() => ([])),
          fetch(studioPath + '/api/changelog').then(r => r.json()).catch(() => ([])),
          fetch(studioPath + '/api/issues').then(r => r.json()).catch(() => ({ open: [], all: [] })),
          fetch(studioPath + '/api/pull-requests').then(r => r.json()).catch(() => ([]))
        ]);

        const status = statusRes.status || statusRes || {};
        const metrics = metricsRes || {};
        const candidates = candidatesRes || [];
        const behavior = behaviorRes || {};
        const events = Array.isArray(eventsRes) ? eventsRes : [];
        const changelog = Array.isArray(changelogRes) ? changelogRes : [];
        const openIssues = issuesRes.open || [];
        const prs = Array.isArray(prsRes) ? prsRes : [];

        // Clear and rebuild modal data cache
        window._studioModalData.clear();

        // Update stats
        document.getElementById('val-shipped-count').textContent = changelog.length;
        document.getElementById('val-pr-count').textContent = prs.filter(p => p.status === 'open').length;
        document.getElementById('val-rollbacks').textContent = status.totalRollbacks || 0;

        // 1. Render Shipped Evolution Timeline
        const changelogContainer = document.getElementById('changelog-list');
        if (changelog.length === 0) {
          changelogContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No autonomous changes recorded yet. Real-time visitor activity will trigger evolution.</div>';
        } else {
          changelogContainer.innerHTML = changelog.map(item => {
            const isLive = item.status === 'live';
            const hasCode = !!(item.code || item.diff);
            const codeKey = 'cl_' + (item.id || item.timestamp || Math.random());
            if (hasCode) {
              window._studioModalData.set(codeKey, { title: 'CODE: ' + item.title, code: item.code || item.diff || '' });
            }

            return \`
              <div class="card" style="border-left: 6px solid var(--maroon);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                  <div style="display: flex; align-items: center; gap: 0.75rem;">
                    <span class="tag tag-maroon">[\${escapeHtml(item.type).toUpperCase()}]</span>
                    <strong style="font-size: 1rem;">\${escapeHtml(item.title)}</strong>
                    <span class="tag \${isLive ? 'tag-green' : 'tag-rose'}">[\${isLive ? 'LIVE' : 'ROLLED BACK'}]</span>
                  </div>
                  <span style="font-family: 'Space Mono', monospace; font-size: 0.75rem; color: var(--text-muted);">\${escapeHtml(new Date(item.shippedAt).toLocaleString())}</span>
                </div>
                <div style="font-size: 0.88rem; line-height: 1.4; margin-bottom: 0.75rem;">\${escapeHtml(item.description)}</div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; font-family: 'Space Mono', monospace; color: var(--text-muted);">
                  <span>PATH: \${escapeHtml(item.path)} \${item.affectedSessions ? '• SESSIONS: ' + item.affectedSessions : ''}</span>
                  <div style="display: flex; gap: 0.5rem;">
                    \${hasCode ? \`<button onclick="showStoredModal('\${codeKey}')" class="btn">[ VIEW CODE ]</button>\` : ''}
                    \${isLive ? \`<button onclick="triggerRollback('\${escapeHtml(item.path)}')" class="btn btn-rose">[ ROLLBACK ]</button>\` : ''}
                  </div>
                </div>
              </div>
            \`;
          }).join('');
        }

        // 2. Render Pull Requests Tab
        const prsContainer = document.getElementById('prs-list');
        if (prs.length === 0) {
          prsContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No open pull requests generated. Click [GENERATE PR] on any detected issue or candidate.</div>';
        } else {
          prsContainer.innerHTML = prs.map(pr => {
            const isOpen = pr.status === 'open';
            const descKey = 'pr_desc_' + pr.id;
            const patchKey = 'pr_patch_' + pr.id;
            window._studioModalData.set(descKey, { title: 'PR DESCRIPTION: ' + pr.title, code: pr.description || '' });
            window._studioModalData.set(patchKey, { title: 'PR PATCH: ' + pr.title, code: pr.patch || '' });

            return \`
              <div class="card" style="border-left: 6px solid var(--border);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                  <div style="display: flex; align-items: center; gap: 0.75rem;">
                    <span class="tag tag-maroon">[PR #\${pr.number}]</span>
                    <strong style="font-size: 1rem;">\${escapeHtml(pr.title)}</strong>
                    <span class="tag \${isOpen ? 'tag-green' : 'tag-rose'}">[\${escapeHtml(pr.status).toUpperCase()}]</span>
                  </div>
                  <span style="font-family: 'Space Mono', monospace; font-size: 0.75rem; color: var(--text-muted);">BRANCH: \${escapeHtml(pr.branchName)}</span>
                </div>
                <div style="font-size: 0.88rem; line-height: 1.4; margin-bottom: 0.75rem;">Target Endpoint: <code>\${escapeHtml(pr.targetPath)}</code></div>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <div style="display: flex; gap: 0.5rem;">
                    <button onclick="showStoredModal('\${descKey}')" class="btn">[ VIEW DESCRIPTION ]</button>
                    <button onclick="showStoredModal('\${patchKey}')" class="btn">[ VIEW PATCH ]</button>
                  </div>
                  \${isOpen ? '<span class="tag tag-amber">[ REVIEW IN GITHUB ]</span>' : ''}
                </div>
              </div>
            \`;
          }).join('');
        }

        // 3. Render Issues Stream
        const issuesContainer = document.getElementById('issues-list');
        if (openIssues.length === 0) {
          issuesContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No open issues detected across active visitor sessions. All systems healthy.</div>';
        } else {
          issuesContainer.innerHTML = openIssues.map(iss => {
            const isCrit = iss.severity === 'critical' || iss.severity === 'high';

            return \`
              <div class="card" style="display: flex; justify-content: space-between; align-items: center; gap: 1.5rem;">
                <div style="flex: 1; min-width: 0;">
                  <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.4rem;">
                    <span class="tag \${isCrit ? 'tag-rose' : 'tag-amber'}">[\${escapeHtml(iss.severity).toUpperCase()}]</span>
                    <strong>\${escapeHtml(iss.type).toUpperCase()}: \${escapeHtml(iss.path)}</strong>
                    <span style="font-family: 'Space Mono', monospace; font-size: 0.75rem; color: var(--text-muted);">\${iss.affectedSessions} SESSIONS AFFECTED</span>
                  </div>
                  <div style="font-size: 0.88rem;">\${escapeHtml(iss.suggestedAction)}</div>
                </div>
                <div style="display: flex; gap: 0.5rem; flex-shrink: 0;">
                  <button onclick="triggerCreatePr('\${escapeHtml(iss.id)}', null)" class="btn btn-maroon">[ GENERATE PR ]</button>
                  <button onclick="triggerEvolveIssue('\${escapeHtml(iss.id)}')" class="btn btn-green">[ AUTONOMOUS EVOLVE ]</button>
                  <button onclick="triggerDismissIssue('\${escapeHtml(iss.id)}')" class="btn">[ DISMISS ]</button>
                </div>
              </div>
            \`;
          }).join('');
        }

        // 4. Render Routes Table
        const tbody = document.getElementById('routes-tbody');
        const routes = Object.keys(metrics.routes || metrics);
        if (routes.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">No traffic detected yet. Send HTTP requests to see metrics.</td></tr>';
        } else {
          tbody.innerHTML = routes.map(routeKey => {
            const r = (metrics.routes || metrics)[routeKey];
            const avg = r.requestCount ? Math.round(r.totalDuration / r.requestCount) : 0;
            const activeVer = (status.activeVersions || []).find(v => v.routeKey === routeKey);
            const isPromoted = activeVer && activeVer.active === 'optimized';

            return \`
              <tr>
                <td style="font-family: 'Space Mono', monospace; font-weight: 700; color: var(--maroon-accent);">\${escapeHtml(routeKey)}</td>
                <td style="font-family: 'Space Mono', monospace;">\${r.requestCount || 0} REQS</td>
                <td style="font-family: 'Space Mono', monospace;">\${avg} MS</td>
                <td><span class="tag \${isPromoted ? 'tag-maroon' : 'tag-amber'}">[\${isPromoted ? 'EVOLVED' : 'ORIGINAL'}]</span></td>
                <td><span class="tag tag-green">[ACTIVE]</span></td>
                <td>
                  <button onclick="triggerPromote('\${escapeHtml(routeKey)}')" class="btn" style="margin-right: 0.35rem;">[ PROMOTE ]</button>
                  <button onclick="triggerRollback('\${escapeHtml(routeKey)}')" class="btn btn-rose">[ ROLLBACK ]</button>
                </td>
              </tr>
            \`;
          }).join('');
        }

        // 5. Render Candidates
        const candidatesContainer = document.getElementById('candidates-list');
        if (candidates.length === 0) {
          candidatesContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 0.85rem;">No active evolution candidates in storage.</div>';
        } else {
          candidatesContainer.innerHTML = candidates.map(c => {
            const candKey = 'cand_' + c.id;
            window._studioModalData.set(candKey, { title: 'CANDIDATE DIFF: ' + c.routeKey, code: c.optimizedCode || '' });

            return \`
              <div class="card" style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                  <div style="display: flex; gap: 0.5rem; margin-bottom: 0.25rem;">
                    <span class="tag tag-maroon">[\${escapeHtml(c.pattern || 'CUSTOM')}]</span>
                    <strong>\${escapeHtml(c.routeKey)}</strong>
                  </div>
                  <div style="font-size: 0.8rem; color: var(--text-muted);">Candidate ID: \${escapeHtml(c.id)}</div>
                </div>
                <div style="display: flex; gap: 0.5rem;">
                  <button onclick="showStoredModal('\${candKey}')" class="btn">[ VIEW DIFF ]</button>
                  <button onclick="triggerCreatePr(null, '\${escapeHtml(c.routeKey)}')" class="btn btn-maroon">[ GENERATE PR ]</button>
                </div>
              </div>
            \`;
          }).join('');
        }

        // 6. Render Behavior
        const patternsContainer = document.getElementById('behavior-patterns');
        const patterns = behavior.patterns || [];
        if (patterns.length === 0) {
          patternsContainer.innerHTML = '<div style="color: var(--text-muted);">No visitor patterns detected yet.</div>';
        } else {
          patternsContainer.innerHTML = patterns.map(p => \`
            <div style="padding: 0.75rem; border: 1px solid var(--border); margin-bottom: 0.5rem;">
              <div style="display: flex; justify-content: space-between; font-weight: 700;">
                <span class="tag tag-amber">[\${escapeHtml(p.type).toUpperCase()}]</span>
                <span style="font-family: 'Space Mono', monospace;">\${p.frequency} HITS</span>
              </div>
              <div style="margin-top: 0.35rem;"><code>\${escapeHtml(p.path)}</code></div>
            </div>
          \`).join('');
        }

        const reactContainer = document.getElementById('react-components-list');
        const components = behavior.components || [];
        if (components.length === 0) {
          reactContainer.innerHTML = '<div style="color: var(--text-muted);">No React frontend components scaffolded yet.</div>';
        } else {
          reactContainer.innerHTML = components.map(c => {
            const reactKey = 'react_' + c.id;
            window._studioModalData.set(reactKey, { title: 'REACT TSX: ' + c.name, code: c.code || '' });

            return \`
              <div style="padding: 0.75rem; border: 1px solid var(--border); margin-bottom: 0.5rem; display: flex; justify-content: space-between; align-items: center;">
                <div>
                  <strong>\${escapeHtml(c.name)}</strong>
                  <div style="font-size: 0.75rem; color: var(--text-muted);">\${escapeHtml(c.routePath || 'Component')}</div>
                </div>
                <button onclick="showStoredModal('\${reactKey}')" class="btn">[ VIEW TSX ]</button>
              </div>
            \`;
          }).join('');
        }

        // 7. Render Events Log
        const eventsLog = document.getElementById('events-log');
        if (events.length === 0) {
          eventsLog.innerHTML = '<div style="color: var(--text-muted);">Waiting for events...</div>';
        } else {
          eventsLog.innerHTML = [...events].reverse().map(e => \`
            <div style="padding: 0.5rem 0.75rem; border-left: 3px solid var(--maroon); border-bottom: 1px solid var(--border); display: flex; gap: 1rem;">
              <span style="color: var(--text-muted);">[\${escapeHtml(new Date(e.ts).toLocaleTimeString())}]</span>
              <strong>\${escapeHtml(e.event).toUpperCase()}</strong>
              <span style="color: var(--text-muted);">\${escapeHtml(e.payload?.routeKey || e.payload?.path || e.payload?.title || '')}</span>
            </div>
          \`).join('');
        }

        // 8. Render Raw State
        document.getElementById('json-viewer').textContent = JSON.stringify({ status, metrics, changelog: changelog.slice(0, 10), openIssues, prs }, null, 2);

      } catch (err) {
        console.error('Dashboard update error', err);
      }
    }

    updateDashboard();
    setInterval(updateDashboard, 3000);
  </script>
</body>
</html>`);
  };
}

function isMutation(req: Request): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase());
}

function isSameOriginRequest(req: Request): boolean {
  const headers = req.headers || {};
  const origin = headers.origin;
  if (!origin) return true;
  const host = headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const protocol = (headers['x-forwarded-proto'] as string || req.protocol || 'http').split(',')[0].trim();
    const parsed = new URL(origin);
    return parsed.protocol === `${protocol}:` && parsed.host === host;
  } catch { return false; }
}

function sanitizeStudioPayload(value: any, depth = 0): any {
  if (depth > 4) return '[TRUNCATED]';
  if (typeof value === 'string') {
    return value
      .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s'";]+/gi, '$1[REDACTED]')
      .replace(/((?:api[_-]?key|token|secret|password|private[_-]?key)\s*[:=]\s*)[^\s'";,]+/gi, '$1[REDACTED]')
      .slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeStudioPayload(item, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, any> = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      output[key] = /^(code|content|sourceCode|originalCode|optimizedCode|token|secret|password|privateKey)$/i.test(key)
        ? '[REDACTED]' : sanitizeStudioPayload(item, depth + 1);
    }
    return output;
  }
  return value;
}
