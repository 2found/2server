export type CliproxyUiInit = {
  app: string;
  companionUrl: string;
  sessionKey: string;
};

function escHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]!));
}

export function renderCliproxyUiHtml(init: CliproxyUiInit): string {
  const safeApp = escHtml(init.app);
  const safeUrl = escHtml(init.companionUrl);
  const safeKey = escHtml(init.sessionKey);
  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>2server · cliproxy (${safeApp}) — Account &amp; Quota Control</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    :root {
      --background: #fafaf9;
      --surface-0: #fafaf9;
      --surface-1: #ffffff;
      --surface-2: #f5f5f0;
      --foreground: #1a1a17;
      --muted: #f5f5f0;
      --muted-foreground: #6b6862;
      --border: rgba(0, 0, 0, 0.07);
      --input: rgba(0, 0, 0, 0.15);
      --primary: #dc2626;
      --primary-hover: #b91c1c;
      --on-primary: #ffffff;
      --accent: #fef2f2;
      --ring: #ef4444;
      --success: #15803d;
      --success-bg: #f0fdf4;
      --success-border: rgba(21, 128, 61, 0.22);
      --warning: #b45309;
      --warning-bg: #fffbeb;
      --warning-border: rgba(180, 83, 9, 0.25);
      --danger: #dc2626;
      --danger-bg: #fef2f2;
      --danger-border: rgba(220, 38, 38, 0.24);
      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --font-body: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      --shadow-sm: 0 1px 2px rgba(26, 26, 23, 0.04);
    }
    html[data-theme="dark"] {
      --background: #0a0a09;
      --surface-0: #0a0a09;
      --surface-1: #141412;
      --surface-2: #1c1c19;
      --foreground: #f5f0e8;
      --muted: #1c1c19;
      --muted-foreground: #8a857c;
      --border: rgba(255, 255, 255, 0.08);
      --input: rgba(255, 255, 255, 0.18);
      --primary: #ef4444;
      --primary-hover: #dc2626;
      --on-primary: #ffffff;
      --accent: rgba(239, 68, 68, 0.12);
      --ring: #ef4444;
      --success: #4ade80;
      --success-bg: rgba(74, 222, 128, 0.1);
      --success-border: rgba(74, 222, 128, 0.25);
      --warning: #fbbf24;
      --warning-bg: rgba(251, 191, 36, 0.1);
      --warning-border: rgba(251, 191, 36, 0.25);
      --danger: #f87171;
      --danger-bg: rgba(248, 113, 113, 0.12);
      --danger-border: rgba(248, 113, 113, 0.28);
      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.35);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--background);
      color: var(--foreground);
      font-family: var(--font-body);
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
    .topbar {
      border-bottom: 1px solid var(--border);
      background: var(--surface-1);
      position: sticky;
      top: 0;
      z-index: 20;
    }
    .topbar-inner {
      max-width: 1280px;
      margin: 0 auto;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      background: var(--foreground);
      color: var(--background);
      font-family: var(--font-mono);
      font-weight: 600;
      font-size: 12px;
    }
    .brand-title { font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--muted-foreground);
    }
    .badge-success { background: var(--success-bg); color: var(--success); border-color: var(--success-border); }
    .badge-warning { background: var(--warning-bg); color: var(--warning); border-color: var(--warning-border); }
    .badge-danger { background: var(--danger-bg); color: var(--danger); border-color: var(--danger-border); }
    .actions-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    button, .btn {
      font-family: var(--font-body);
      font-size: 13px;
      font-weight: 500;
      padding: 7px 12px;
      border-radius: var(--radius-md);
      border: 1px solid var(--input);
      background: var(--surface-1);
      color: var(--foreground);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-decoration: none;
    }
    button:hover, .btn:hover { background: var(--surface-2); }
    button:focus-visible, .btn:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: 2px solid var(--ring);
      outline-offset: 1px;
    }
    .btn-primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
    .btn-primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
    .btn-sm { padding: 4px 9px; font-size: 12px; border-radius: var(--radius-sm); }
    .btn-danger { color: var(--danger); border-color: var(--danger-border); background: var(--danger-bg); }
    .container { max-width: 1280px; margin: 0 auto; padding: 24px; display: flex; flex-direction: column; gap: 20px; }
    .toast {
      padding: 10px 14px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
      background: var(--surface-1);
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 13px;
    }
    .toast.visible { display: flex; }
    .kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .card {
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 16px;
      box-shadow: var(--shadow-sm);
    }
    .kpi-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--muted-foreground);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .kpi-value { font-size: 24px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .kpi-sub { font-size: 12px; color: var(--muted-foreground); margin-top: 4px; }
    .drawer {
      display: none;
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 18px;
      box-shadow: var(--shadow-sm);
    }
    .drawer.open { display: block; }
    .drawer-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .drawer-title { font-size: 15px; font-weight: 600; }
    .provider-pills { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
    .provider-pill {
      padding: 6px 12px;
      border-radius: var(--radius-md);
      border: 1px solid var(--input);
      background: var(--surface-1);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .provider-pill.active { background: var(--foreground); color: var(--background); border-color: var(--foreground); }
    .form-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
    input[type="text"], input[type="number"], select, textarea {
      font-family: var(--font-body);
      font-size: 13px;
      padding: 7px 10px;
      border-radius: var(--radius-md);
      border: 1px solid var(--input);
      background: var(--surface-1);
      color: var(--foreground);
    }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .tabs {
      display: inline-flex;
      background: var(--surface-2);
      padding: 3px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
      gap: 2px;
      flex-wrap: wrap;
    }
    .tab {
      border: none;
      background: transparent;
      padding: 5px 11px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 500;
      color: var(--muted-foreground);
      cursor: pointer;
    }
    .tab.active { background: var(--surface-1); color: var(--foreground); box-shadow: var(--shadow-sm); }
    .search-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .table-card {
      background: var(--surface-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }
    .table-scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th {
      font-size: 12px;
      font-weight: 600;
      color: var(--muted-foreground);
      padding: 11px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--surface-2);
      white-space: nowrap;
    }
    td { padding: 14px 16px; border-bottom: 1px solid var(--border); vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .acc-name { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .acc-file { font-family: var(--font-mono); font-size: 12px; color: var(--muted-foreground); margin-top: 2px; }
    .quota-stack { display: flex; flex-direction: column; gap: 8px; min-width: 240px; }
    .quota-item { display: flex; flex-direction: column; gap: 3px; }
    .quota-head { display: flex; justify-content: space-between; font-size: 12px; gap: 8px; }
    .quota-model { font-weight: 500; }
    .quota-pct { font-family: var(--font-mono); font-weight: 600; }
    .quota-track { height: 6px; border-radius: 999px; background: var(--surface-2); overflow: hidden; border: 1px solid var(--border); }
    .quota-fill { height: 100%; border-radius: 999px; transition: width 250ms cubic-bezier(0.16,1,0.3,1); }
    .fill-ok { background: var(--success); }
    .fill-warn { background: var(--warning); }
    .fill-low { background: var(--danger); }
    .cooldown-list { display: flex; flex-direction: column; gap: 6px; }
    .cooldown-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      background: var(--warning-bg);
      color: var(--warning);
      border: 1px solid var(--warning-border);
      font-family: var(--font-mono);
    }
    .verify-box {
      padding: 8px 10px;
      border-radius: var(--radius-md);
      background: var(--danger-bg);
      border: 1px solid var(--danger-border);
      color: var(--danger);
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .priority-input { width: 68px; padding: 4px 7px; font-family: var(--font-mono); font-size: 12px; text-align: right; }
    .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .section-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; }
    .code-box {
      font-family: var(--font-mono);
      font-size: 12px;
      padding: 10px 12px;
      border-radius: var(--radius-md);
      background: var(--surface-2);
      border: 1px solid var(--border);
      overflow-x: auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .alias-list { display: flex; flex-wrap: wrap; gap: 6px; }
    @media (max-width: 900px) {
      .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .bottom-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 560px) {
      .container { padding: 14px; }
      .topbar-inner { padding: 12px 14px; }
      .kpi-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <span class="brand-mark">2srv</span>
        <div class="brand-title">
          <span>cliproxy</span>
          <span class="badge mono" id="app-badge">app: ${safeApp}</span>
          <span class="badge badge-success" id="conn-badge">● Loopback Gateway Active</span>
        </div>
      </div>
      <div class="actions-row">
        <button type="button" id="btn-refresh-quota" onclick="refreshQuotas()">↻ Refresh Quotas</button>
        <button type="button" id="btn-open-signin" class="btn-primary" onclick="toggleDrawer('signin-drawer')">+ Sign In Account</button>
        <button type="button" id="btn-open-import" onclick="toggleDrawer('import-drawer')">↑ Import .json</button>
        <button type="button" id="btn-theme" onclick="toggleTheme()" aria-label="Toggle color theme">◐ Theme</button>
      </div>
    </div>
  </header>

  <main class="container">
    <div id="status-toast" class="toast" role="status" aria-live="polite">
      <span id="status-toast-text"></span>
      <button type="button" class="btn-sm" onclick="hideToast()">Dismiss</button>
    </div>

    <section class="kpi-grid" aria-label="Gateway summary">
      <div class="card">
        <div class="kpi-label"><span>Accounts Ready</span><span class="badge badge-success" id="kpi-ready-pill">Healthy</span></div>
        <div class="kpi-value" id="kpi-ready-count">0 / 0</div>
        <div class="kpi-sub" id="kpi-ready-sub">Loading accounts...</div>
      </div>
      <div class="card">
        <div class="kpi-label"><span>Gemini Flash Pool</span><span class="mono">antigravity</span></div>
        <div class="kpi-value" id="kpi-flash-avg">—</div>
        <div class="kpi-sub" id="kpi-flash-sub">Avg remaining across ready Flash accounts</div>
      </div>
      <div class="card">
        <div class="kpi-label"><span>Claude &amp; Codex Pool</span><span class="mono">pro / max</span></div>
        <div class="kpi-value" id="kpi-claude-avg">—</div>
        <div class="kpi-sub" id="kpi-claude-sub">Avg remaining across Claude / Codex pools</div>
      </div>
      <div class="card">
        <div class="kpi-label"><span>Total Requests</span><span class="mono">runtime</span></div>
        <div class="kpi-value" id="kpi-requests">0</div>
        <div class="kpi-sub" id="kpi-requests-sub">0 succeeded · 0 failed</div>
      </div>
    </section>

    <section id="signin-drawer" class="drawer" aria-label="Sign in provider account">
      <div class="drawer-header">
        <div class="drawer-title">Sign In OAuth Provider Account</div>
        <button type="button" class="btn-sm" onclick="toggleDrawer('signin-drawer')">Close</button>
      </div>
      <p style="font-size: 13px; color: var(--muted-foreground); margin-bottom: 10px;">
        Starts an OAuth sign-in on the container and listens on your local loopback callback port automatically. If the browser opens on another machine, paste the final redirect URL below.
      </p>
      <div class="provider-pills" role="group" aria-label="Select OAuth provider">
        <button type="button" class="provider-pill active" data-provider="antigravity" onclick="selectProvider('antigravity')">antigravity (Google)</button>
        <button type="button" class="provider-pill" data-provider="codex" onclick="selectProvider('codex')">codex (OpenAI)</button>
        <button type="button" class="provider-pill" data-provider="claude" onclick="selectProvider('claude')">claude (Anthropic)</button>
        <button type="button" class="provider-pill" data-provider="xai" onclick="selectProvider('xai')">xai (Grok Device Code)</button>
        <button type="button" class="provider-pill" data-provider="kimi" onclick="selectProvider('kimi')">kimi</button>
      </div>
      <div class="form-row">
        <button type="button" class="btn-primary" id="btn-start-oauth" onclick="startOAuthFlow()">Launch Browser Sign-In</button>
        <span id="oauth-status-label" class="mono" style="font-size: 12px; color: var(--muted-foreground);">Provider: antigravity</span>
      </div>
      <div id="oauth-session-box" style="display:none; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border);">
        <div style="font-size: 12px; font-weight: 600; margin-bottom: 6px;">Authorization URL:</div>
        <div class="code-box">
          <a id="oauth-auth-link" href="#" target="_blank" rel="noopener noreferrer" class="mono" style="color: var(--primary); word-break: break-all;"></a>
          <button type="button" class="btn-sm" onclick="copyText(document.getElementById('oauth-auth-link').textContent)">Copy URL</button>
        </div>
        <div id="oauth-device-code" style="display:none; margin-top: 8px;" class="badge badge-warning mono"></div>
        <div class="form-row" style="margin-top: 12px;">
          <input type="text" id="oauth-callback-input" placeholder="Paste http://localhost:PORT/auth/callback?code=...&state=... if browser ran elsewhere" style="flex: 1; min-width: 280px;" aria-label="OAuth callback redirect URL" />
          <button type="button" id="btn-submit-callback" onclick="submitOAuthCallback()">Complete Sign-In</button>
        </div>
      </div>
    </section>

    <section id="import-drawer" class="drawer" aria-label="Import auth file">
      <div class="drawer-header">
        <div class="drawer-title">Import Provider Auth JSON</div>
        <button type="button" class="btn-sm" onclick="toggleDrawer('import-drawer')">Close</button>
      </div>
      <p style="font-size: 13px; color: var(--muted-foreground); margin-bottom: 10px;">
        Upload an auth JSON file (<span class="mono">*.json</span> with a top-level <span class="mono">"type"</span> field). Refresh tokens rotate, so move accounts rather than running the same file on two gateways.
      </p>
      <div class="form-row">
        <input type="text" id="import-filename" placeholder="codex-team@example.com.json" class="mono" style="width: 260px;" aria-label="Account file name" />
        <input type="file" id="import-file-input" accept=".json,application/json" onchange="handleFileSelect(event)" aria-label="Choose JSON auth file" />
        <button type="button" id="btn-submit-import" class="btn-primary" onclick="submitImportJson()">Upload to Gateway</button>
      </div>
      <textarea id="import-json-body" rows="4" placeholder='{"type":"codex","email":"team@example.com","refresh_token":"..."}' class="mono" style="width: 100%; margin-top: 10px;" aria-label="Auth JSON payload"></textarea>
    </section>

    <section class="toolbar" aria-label="Account filters">
      <div class="tabs" role="tablist" aria-label="Filter by status">
        <button type="button" class="tab active" data-filter="all" onclick="setFilter('all')">All (0)</button>
        <button type="button" class="tab" data-filter="ready" onclick="setFilter('ready')">Ready (0)</button>
        <button type="button" class="tab" data-filter="cooling" onclick="setFilter('cooling')">Cooling Down (0)</button>
        <button type="button" class="tab" data-filter="attention" onclick="setFilter('attention')">Needs Attention (0)</button>
      </div>
      <div class="search-group">
        <select id="provider-filter" onchange="renderAccounts()" aria-label="Filter by provider">
          <option value="all">All providers</option>
          <option value="antigravity">antigravity</option>
          <option value="codex">codex</option>
          <option value="claude">claude</option>
          <option value="xai">xai</option>
          <option value="kimi">kimi</option>
        </select>
        <input type="text" id="account-search" placeholder="Search email or file..." oninput="renderAccounts()" aria-label="Search accounts" />
        <button type="button" id="btn-reset-all" class="btn-sm" onclick="resetAllCooldowns()">Reset All Cooldowns</button>
      </div>
    </section>

    <section class="table-card" aria-label="Provider accounts and live quota">
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Account &amp; Provider</th>
              <th>Status &amp; Priority</th>
              <th>Live Remaining Quota</th>
              <th>Active Cooldowns / Alerts</th>
              <th>Requests</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="accounts-tbody"></tbody>
        </table>
      </div>
    </section>

    <section class="bottom-grid" aria-label="Models and Companion App bridge">
      <div class="card">
        <div class="section-title">
          <span>Requestable Models &amp; Aliases (<span class="mono">/v1/models</span>)</span>
          <span class="badge mono" id="models-count-badge">0 models</span>
        </div>
        <p style="font-size: 12px; color: var(--muted-foreground); margin-bottom: 10px;">
          Requests try the highest account priority with a ready account across pooled channels before falling back to lower priorities.
        </p>
        <div id="models-list" class="alias-list"></div>
      </div>

      <div class="card">
        <div class="section-title">
          <span>Companion App &amp; Management API Bridge</span>
          <span class="badge badge-success">Loopback Only</span>
        </div>
        <p style="font-size: 12px; color: var(--muted-foreground); margin-bottom: 10px;">
          Connect external companion apps (<span class="mono">Cli-Proxy-API-Management-Center</span>, <span class="mono">CPA-Manager</span>, <span class="mono">CLIProxyAPI-Quota-Inspector</span>) using this local endpoint and ephemeral session key. Real VM secrets and OAuth tokens never leave the server.
        </p>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <div class="code-box">
            <span>Base URL: <strong id="companion-url">${safeUrl}</strong></span>
            <button type="button" class="btn-sm" onclick="copyText(document.getElementById('companion-url').textContent)">Copy</button>
          </div>
          <div class="code-box">
            <span>Session Key: <strong id="companion-key">${safeKey}</strong></span>
            <button type="button" class="btn-sm" onclick="copyText(document.getElementById('companion-key').textContent)">Copy Key</button>
          </div>
        </div>
      </div>
    </section>
  </main>

  <script>
    const SESSION_KEY = ${JSON.stringify(init.sessionKey)};
    let state = {
      accounts: [],
      models: [],
      filter: "all",
      selectedProvider: "antigravity",
      oauthState: ""
    };

    function esc(s) {
      return String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    async function apiCall(path, options = {}) {
      const headers = Object.assign({
        "Authorization": "Bearer " + SESSION_KEY,
        "Content-Type": "application/json"
      }, options.headers || {});
      const res = await fetch(path, Object.assign({}, options, { headers }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      return data;
    }

    function showToast(msg) {
      const el = document.getElementById("status-toast");
      document.getElementById("status-toast-text").textContent = msg;
      el.classList.add("visible");
    }
    function hideToast() {
      document.getElementById("status-toast").classList.remove("visible");
    }
    function toggleTheme() {
      const html = document.documentElement;
      html.setAttribute("data-theme", html.getAttribute("data-theme") === "dark" ? "light" : "dark");
    }
    function toggleDrawer(id) {
      document.getElementById(id).classList.toggle("open");
    }
    function selectProvider(p) {
      state.selectedProvider = p;
      document.querySelectorAll(".provider-pill").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.provider === p);
      });
      document.getElementById("oauth-status-label").textContent = "Provider: " + p;
    }
    function setFilter(f) {
      state.filter = f;
      document.querySelectorAll(".tab").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.filter === f);
      });
      renderAccounts();
    }
    function formatRemainingSecs(s) {
      if (!s || s <= 0) return "0m";
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return h > 0 ? (h + "h " + m + "m") : (m + "m");
    }
    function accountCategory(a) {
      if (a.validationUrl || a.error || (a.message && a.message.includes("403"))) return "attention";
      if ((a.cooldowns && a.cooldowns.length > 0) || a.unavailable) return "cooling";
      return "ready";
    }

    async function loadState(withQuota = true) {
      try {
        const base = await apiCall("/api/state");
        state.accounts = Array.isArray(base.accounts) ? base.accounts : [];
        state.models = Array.isArray(base.models) ? base.models : [];
        renderAccounts();
        renderModels();
        if (withQuota) await refreshQuotas(true);
      } catch (err) {
        showToast("Failed to load state: " + err.message);
      }
    }

    async function refreshQuotas(silent = false) {
      try {
        const data = await apiCall("/api/quota");
        if (Array.isArray(data.accounts)) {
          state.accounts = data.accounts;
          renderAccounts();
        }
        if (!silent) showToast("Refreshed live upstream quotas.");
      } catch (err) {
        showToast("Quota refresh error: " + err.message);
      }
    }

    async function startOAuthFlow() {
      const p = state.selectedProvider;
      try {
        const res = await apiCall("/api/login/start", {
          method: "POST",
          body: JSON.stringify({ provider: p })
        });
        state.oauthState = res.state || "";
        const box = document.getElementById("oauth-session-box");
        const link = document.getElementById("oauth-auth-link");
        const device = document.getElementById("oauth-device-code");
        box.style.display = "block";
        link.href = res.url;
        link.textContent = res.url;
        if (res.userCode) {
          device.style.display = "inline-flex";
          device.textContent = "Device Code: " + res.userCode;
        } else if (res.callbackPort) {
          device.style.display = "inline-flex";
          device.textContent = "Listening on http://127.0.0.1:" + res.callbackPort + " for browser redirect...";
        } else {
          device.style.display = "none";
        }
        showToast("Started " + p + " sign-in flow.");
        pollOAuthStatus(state.oauthState);
      } catch (err) {
        showToast("Sign-in error: " + err.message);
      }
    }

    async function pollOAuthStatus(oauthState) {
      if (!oauthState) return;
      for (let i = 0; i < 60; i++) {
        if (state.oauthState !== oauthState) return;
        const { promise, resolve } = Promise.withResolvers();
        setTimeout(resolve, 2000);
        await promise;
        try {
          const st = await apiCall("/api/login/status?state=" + encodeURIComponent(oauthState));
          if (st.status === "ok") {
            state.oauthState = "";
            document.getElementById("oauth-session-box").style.display = "none";
            await loadState(true);
            showToast("Account signed in and stored.");
            return;
          }
          if (st.status === "error") {
            state.oauthState = "";
            showToast("Sign-in failed: " + (st.error || "unknown"));
            return;
          }
        } catch {
          return;
        }
      }
    }

    async function submitOAuthCallback() {
      const val = document.getElementById("oauth-callback-input").value.trim();
      if (!val || !/^https?:\\/\\//.test(val)) {
        showToast("Please paste a valid http://localhost:... callback URL.");
        return;
      }
      try {
        await apiCall("/api/login/callback", {
          method: "POST",
          body: JSON.stringify({ redirectUrl: val, state: state.oauthState })
        });
        state.oauthState = "";
        document.getElementById("oauth-callback-input").value = "";
        document.getElementById("oauth-session-box").style.display = "none";
        await loadState(true);
        showToast("Completed OAuth callback and stored account.");
      } catch (err) {
        showToast("Callback error: " + err.message);
      }
    }

    function handleFileSelect(ev) {
      const file = ev.target.files?.[0];
      if (!file) return;
      document.getElementById("import-filename").value = file.name;
      const reader = new FileReader();
      reader.onload = () => {
        document.getElementById("import-json-body").value = String(reader.result || "");
      };
      reader.readAsText(file);
    }

    async function submitImportJson() {
      const name = document.getElementById("import-filename").value.trim();
      const content = document.getElementById("import-json-body").value.trim();
      try {
        const res = await apiCall("/api/import", {
          method: "POST",
          body: JSON.stringify({ name, content })
        });
        document.getElementById("import-json-body").value = "";
        await loadState(true);
        showToast("Imported " + res.account + ".");
      } catch (err) {
        showToast("Import failed: " + err.message);
      }
    }

    async function savePriority(name) {
      const input = document.getElementById("prio-" + name);
      const priority = Number(input.value);
      try {
        await apiCall("/api/priority", {
          method: "POST",
          body: JSON.stringify({ name, priority })
        });
        await loadState(false);
        showToast("Updated priority for " + name + " to " + priority + ".");
      } catch (err) {
        showToast("Priority error: " + err.message);
      }
    }

    async function toggleDisable(name, currentlyDisabled) {
      try {
        await apiCall("/api/status", {
          method: "POST",
          body: JSON.stringify({ name, disabled: !currentlyDisabled })
        });
        await loadState(false);
        showToast((!currentlyDisabled ? "Disabled " : "Enabled ") + name + ".");
      } catch (err) {
        showToast("Status update failed: " + err.message);
      }
    }

    async function resetQuota(name) {
      try {
        await apiCall("/api/reset-quota", {
          method: "POST",
          body: JSON.stringify({ name })
        });
        await loadState(true);
        showToast("Cleared quota cooldown latch for " + name + ".");
      } catch (err) {
        showToast("Reset quota failed: " + err.message);
      }
    }

    async function resetAllCooldowns() {
      try {
        const res = await apiCall("/api/reset-quota", {
          method: "POST",
          body: JSON.stringify({ all: true })
        });
        await loadState(true);
        showToast("Reset cooldown latches on " + (res.accounts ? res.accounts.length : 0) + " account(s).");
      } catch (err) {
        showToast("Reset all failed: " + err.message);
      }
    }

    async function removeAccount(name) {
      try {
        await apiCall("/api/remove", {
          method: "POST",
          body: JSON.stringify({ name })
        });
        await loadState(false);
        showToast("Removed account " + name + ".");
      } catch (err) {
        showToast("Remove failed: " + err.message);
      }
    }

    function copyText(text) {
      navigator.clipboard?.writeText(text || "");
      showToast("Copied to clipboard.");
    }

    function updateKpis() {
      const counts = { all: state.accounts.length, ready: 0, cooling: 0, attention: 0 };
      let totalOk = 0, totalErr = 0;
      const flashPcts = [], claudeCodexPcts = [];

      state.accounts.forEach(a => {
        if (!a.disabled) counts[accountCategory(a)]++;
        totalOk += Number(a.success || 0);
        totalErr += Number(a.failed || 0);
        (a.quotas || []).forEach(q => {
          const pct = Number(q.remainingPercent);
          if (!Number.isFinite(pct)) return;
          if (/flash|gemini/i.test(q.label || q.model || "")) flashPcts.push(pct);
          if (/claude|codex|primary/i.test(q.label || q.model || "")) claudeCodexPcts.push(pct);
        });
      });

      document.querySelector('[data-filter="all"]').textContent = "All (" + counts.all + ")";
      document.querySelector('[data-filter="ready"]').textContent = "Ready (" + counts.ready + ")";
      document.querySelector('[data-filter="cooling"]').textContent = "Cooling Down (" + counts.cooling + ")";
      document.querySelector('[data-filter="attention"]').textContent = "Needs Attention (" + counts.attention + ")";
      document.getElementById("kpi-ready-count").textContent = counts.ready + " / " + counts.all;
      document.getElementById("kpi-ready-sub").textContent = counts.cooling + " cooling down · " + counts.attention + " need attention";

      const avg = arr => arr.length ? (arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1) + "%" : "—";
      document.getElementById("kpi-flash-avg").textContent = avg(flashPcts);
      document.getElementById("kpi-claude-avg").textContent = avg(claudeCodexPcts);
      document.getElementById("kpi-requests").textContent = (totalOk + totalErr).toLocaleString();
      document.getElementById("kpi-requests-sub").textContent = totalOk.toLocaleString() + " succeeded · " + totalErr.toLocaleString() + " failed";
    }

    function renderAccounts() {
      updateKpis();
      const tbody = document.getElementById("accounts-tbody");
      const provFilter = document.getElementById("provider-filter").value;
      const q = document.getElementById("account-search").value.trim().toLowerCase();

      const filtered = state.accounts.filter(a => {
        if (state.filter !== "all" && accountCategory(a) !== state.filter) return false;
        if (provFilter !== "all" && a.provider !== provFilter) return false;
        if (q && !(String(a.name || "").toLowerCase().includes(q) || String(a.label || "").toLowerCase().includes(q))) return false;
        return true;
      });

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 32px; color: var(--muted-foreground);">No accounts match the selected filter.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(a => {
        const cat = accountCategory(a);
        const statusBadge = a.disabled
          ? '<span class="badge">Disabled</span>'
          : cat === "attention"
          ? '<span class="badge badge-danger">Needs Attention</span>'
          : cat === "cooling"
          ? '<span class="badge badge-warning">Cooling Down</span>'
          : '<span class="badge badge-success">Ready</span>';

        const quotasHtml = (a.quotas && a.quotas.length)
          ? '<div class="quota-stack">' + a.quotas.map(qm => {
              const pct = Number(qm.remainingPercent ?? 0);
              const fillClass = pct > 50 ? "fill-ok" : pct >= 15 ? "fill-warn" : "fill-low";
              const rst = qm.resetTime ? (" · resets " + esc(qm.resetTime.slice(5, 16).replace("T", " ")) + "Z") : "";
              return '<div class="quota-item">' +
                '<div class="quota-head">' +
                  '<span class="quota-model">' + esc(qm.label || qm.model) + '</span>' +
                  '<span class="quota-pct">' + pct.toFixed(1) + '%' + rst + '</span>' +
                '</div>' +
                '<div class="quota-track"><div class="quota-fill ' + fillClass + '" style="width: ' + Math.max(2, Math.min(100, pct)) + '%"></div></div>' +
              '</div>';
            }).join("") + '</div>'
          : '<span style="color: var(--muted-foreground); font-size: 12px;">No quota signal available</span>';

        const cooldownsHtml = [];
        if (a.validationUrl) {
          cooldownsHtml.push('<div class="verify-box">' +
            '<span>Google security check required (403 VALIDATION_REQUIRED)</span>' +
            '<a class="btn btn-sm btn-primary" href="' + esc(a.validationUrl) + '" target="_blank" rel="noopener noreferrer">Verify Google Account ↗</a>' +
          '</div>');
        } else if (a.error || a.message) {
          cooldownsHtml.push('<div class="verify-box"><span>' + esc(a.error || a.message) + '</span></div>');
        }
        if (a.cooldowns && a.cooldowns.length) {
          a.cooldowns.forEach(c => {
            cooldownsHtml.push('<span class="cooldown-chip">' + esc(c.model) + ': ' + esc(c.reason) + ' (' + formatRemainingSecs(c.remainingSeconds) + ')</span>');
          });
        }
        if (cooldownsHtml.length === 0) {
          cooldownsHtml.push('<span style="color: var(--muted-foreground); font-size: 12px;">None</span>');
        }

        const safeName = esc(a.name);
        return '<tr>' +
          '<td>' +
            '<div class="acc-name">' +
              '<span>' + esc(a.label || a.name) + '</span>' +
              '<span class="badge mono">' + esc(a.provider) + (a.planType ? (' · ' + esc(a.planType)) : '') + '</span>' +
            '</div>' +
            '<div class="acc-file">' + safeName + '</div>' +
          '</td>' +
          '<td>' +
            '<div style="display:flex; flex-direction:column; gap:8px; align-items:flex-start;">' +
              statusBadge +
              '<div style="display:flex; align-items:center; gap:4px;">' +
                '<label for="prio-' + safeName + '" style="font-size:12px; color:var(--muted-foreground);">Priority:</label>' +
                '<input id="prio-' + safeName + '" type="number" class="priority-input" value="' + Number(a.priority ?? 0) + '" min="-9999" max="9999" />' +
                '<button type="button" class="btn-sm" data-account="' + safeName + '" onclick="savePriority(this.dataset.account)">Save</button>' +
              '</div>' +
            '</div>' +
          '</td>' +
          '<td>' + quotasHtml + '</td>' +
          '<td><div class="cooldown-list">' + cooldownsHtml.join("") + '</div></td>' +
          '<td class="mono">' +
            '<div><span style="color:var(--success);">' + Number(a.success ?? 0) + '</span> ok</div>' +
            '<div style="font-size:12px; color:var(--muted-foreground);">' + Number(a.failed ?? 0) + ' err</div>' +
          '</td>' +
          '<td>' +
            '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
              '<button type="button" class="btn-sm" data-account="' + safeName + '" onclick="resetQuota(this.dataset.account)">Reset Quota</button>' +
              '<button type="button" class="btn-sm" data-account="' + safeName + '" onclick="toggleDisable(this.dataset.account, ' + (!!a.disabled) + ')">' + (a.disabled ? "Enable" : "Disable") + '</button>' +
              '<button type="button" class="btn-sm btn-danger" data-account="' + safeName + '" onclick="removeAccount(this.dataset.account)">Remove</button>' +
            '</div>' +
          '</td>' +
        '</tr>';
      }).join("");
    }

    function renderModels() {
      const container = document.getElementById("models-list");
      document.getElementById("models-count-badge").textContent = state.models.length + " models";
      container.innerHTML = state.models.map(m => '<span class="badge mono">' + esc(m) + '</span>').join("");
    }

    loadState(true);
  </script>
</body>
</html>`;
}
