/** Single-file HTML frontend for egirl API & config dashboard */

export function buildFrontendHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>egirl — dashboard</title>
<style>
  :root {
    --purple: #af5fd7;
    --pink: #ff5faf;
    --orchid: #d75fd7;
    --gray: #767676;
    --green: #87d787;
    --rose: #ff5f87;
    --gold: #ffd75f;
    --lilac: #af87ff;
    --bg: #0e0e1a;
    --bg-card: #161625;
    --bg-input: #1a1a2e;
    --bg-hover: #1e1e32;
    --border: #2a2a40;
    --text: #d4d4e0;
    --text-dim: #8888a0;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
    min-height: 100vh;
  }

  /* ── layout ── */
  .shell {
    display: grid;
    grid-template-columns: 200px 1fr;
    min-height: 100vh;
  }

  nav {
    background: var(--bg-card);
    border-right: 1px solid var(--border);
    padding: 16px 0;
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
  }

  nav .brand {
    padding: 0 16px 16px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
  }

  nav .brand h1 {
    font-size: 18px;
    font-weight: 700;
    color: var(--pink);
    letter-spacing: 1px;
  }

  nav .brand .sub {
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 2px;
  }

  nav a {
    display: block;
    padding: 8px 16px;
    color: var(--text-dim);
    text-decoration: none;
    font-size: 12px;
    border-left: 2px solid transparent;
    transition: all 0.15s;
  }

  nav a:hover { color: var(--text); background: var(--bg-hover); }
  nav a.active { color: var(--purple); border-left-color: var(--purple); background: var(--bg-hover); }

  nav .nav-group {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-dim);
    padding: 12px 16px 4px;
    opacity: 0.6;
  }

  main {
    padding: 24px 32px;
    max-width: 960px;
    overflow-y: auto;
  }

  /* ── typography ── */
  h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--purple);
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  h3 {
    font-size: 13px;
    font-weight: 600;
    color: var(--orchid);
    margin: 16px 0 8px;
  }

  /* ── cards ── */
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 16px;
  }

  .card-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }

  .stat-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 14px 16px;
  }

  .stat-card .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-dim);
    margin-bottom: 4px;
  }

  .stat-card .value {
    font-size: 20px;
    font-weight: 700;
    color: var(--text);
  }

  .stat-card .value.ok { color: var(--green); }
  .stat-card .value.err { color: var(--rose); }
  .stat-card .value.purple { color: var(--purple); }
  .stat-card .value.pink { color: var(--pink); }
  .stat-card .value.gold { color: var(--gold); }

  /* ── indicators ── */
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
  }
  .dot.on { background: var(--green); }
  .dot.off { background: var(--rose); }
  .dot.warn { background: var(--gold); }

  .badge {
    display: inline-block;
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 3px;
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .badge.ok { background: rgba(135, 215, 135, 0.15); color: var(--green); }
  .badge.err { background: rgba(255, 95, 135, 0.15); color: var(--rose); }
  .badge.info { background: rgba(175, 135, 255, 0.15); color: var(--lilac); }

  /* ── forms ── */
  .field {
    margin-bottom: 12px;
  }

  .field label {
    display: block;
    font-size: 11px;
    color: var(--text-dim);
    margin-bottom: 4px;
    letter-spacing: 0.3px;
  }

  .field input[type="text"],
  .field input[type="number"],
  .field input[type="password"],
  .field select,
  .field textarea {
    width: 100%;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 7px 10px;
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
    outline: none;
    transition: border-color 0.15s;
  }

  .field input:focus,
  .field select:focus,
  .field textarea:focus {
    border-color: var(--purple);
  }

  .field textarea {
    resize: vertical;
    min-height: 60px;
  }

  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .field .hint {
    font-size: 10px;
    color: var(--text-dim);
    margin-top: 3px;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
  }

  .toggle-row:last-child { border-bottom: none; }

  .toggle-row .toggle-label {
    font-size: 12px;
    color: var(--text);
  }

  .toggle-row .toggle-desc {
    font-size: 10px;
    color: var(--text-dim);
  }

  /* toggle switch */
  .switch {
    position: relative;
    width: 36px;
    height: 20px;
    flex-shrink: 0;
  }

  .switch input { opacity: 0; width: 0; height: 0; }

  .switch .slider {
    position: absolute;
    inset: 0;
    background: var(--border);
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.2s;
  }

  .switch .slider::before {
    content: '';
    position: absolute;
    width: 14px;
    height: 14px;
    left: 3px;
    top: 3px;
    background: var(--text-dim);
    border-radius: 50%;
    transition: all 0.2s;
  }

  .switch input:checked + .slider { background: var(--purple); }
  .switch input:checked + .slider::before { transform: translateX(16px); background: #fff; }

  /* tag chips */
  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }

  .tag {
    display: inline-flex;
    align-items: center;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 3px 8px;
    font-size: 11px;
    color: var(--text);
  }

  .tag .tag-rm {
    margin-left: 6px;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
  }

  .tag .tag-rm:hover { color: var(--rose); }

  .tag-input {
    background: transparent;
    border: none;
    color: var(--text);
    font-family: inherit;
    font-size: 11px;
    outline: none;
    width: 120px;
    padding: 3px 4px;
  }

  /* slider */
  input[type="range"] {
    -webkit-appearance: none;
    width: 100%;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    outline: none;
    margin: 8px 0;
  }

  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    background: var(--purple);
    border-radius: 50%;
    cursor: pointer;
  }

  .range-val {
    font-size: 12px;
    color: var(--orchid);
    font-weight: 600;
    float: right;
    margin-top: -2px;
  }

  /* buttons */
  .btn {
    display: inline-block;
    padding: 7px 16px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s;
    background: var(--bg-input);
    color: var(--text);
  }

  .btn:hover { border-color: var(--purple); color: var(--purple); }

  .btn.primary {
    background: var(--purple);
    border-color: var(--purple);
    color: #fff;
  }

  .btn.primary:hover { background: #9b4fc0; }

  .btn.danger {
    border-color: var(--rose);
    color: var(--rose);
  }

  .btn.danger:hover { background: rgba(255, 95, 135, 0.1); }

  .btn-row {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }

  /* ── API explorer ── */
  .endpoint {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-bottom: 8px;
    overflow: hidden;
  }

  .endpoint-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .endpoint-header:hover { background: var(--bg-hover); }

  .endpoint .method {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 3px;
    letter-spacing: 0.5px;
    min-width: 48px;
    text-align: center;
  }

  .method.get { background: rgba(135, 215, 135, 0.15); color: var(--green); }
  .method.post { background: rgba(175, 95, 215, 0.15); color: var(--purple); }
  .method.put { background: rgba(255, 215, 95, 0.15); color: var(--gold); }
  .method.delete { background: rgba(255, 95, 135, 0.15); color: var(--rose); }

  .endpoint .path {
    font-size: 12px;
    color: var(--text);
    flex: 1;
  }

  .endpoint .summary {
    font-size: 11px;
    color: var(--text-dim);
  }

  .endpoint-body {
    display: none;
    padding: 14px;
    border-top: 1px solid var(--border);
    background: var(--bg);
  }

  .endpoint.open .endpoint-body { display: block; }

  .endpoint-body pre {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 10px;
    font-size: 11px;
    overflow-x: auto;
    color: var(--text);
    margin-top: 8px;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .response-status {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .response-status.s2xx { color: var(--green); }
  .response-status.s4xx { color: var(--gold); }
  .response-status.s5xx { color: var(--rose); }

  /* ── chat panel ── */
  .chat-log {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 12px;
    min-height: 200px;
    max-height: 400px;
    overflow-y: auto;
    margin-bottom: 12px;
    font-size: 12px;
  }

  .chat-log .msg {
    margin-bottom: 10px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }

  .chat-log .msg:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
  .chat-log .msg .role { font-weight: 600; margin-bottom: 2px; }
  .chat-log .msg .role.user { color: var(--purple); }
  .chat-log .msg .role.agent { color: var(--pink); }
  .chat-log .msg .meta { font-size: 10px; color: var(--text-dim); margin-top: 4px; }
  .chat-log .msg .body { white-space: pre-wrap; word-break: break-word; }

  .chat-input-row {
    display: flex;
    gap: 8px;
  }

  .chat-input-row input {
    flex: 1;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px 10px;
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
    outline: none;
  }

  .chat-input-row input:focus { border-color: var(--purple); }

  /* ── memory ── */
  .mem-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .mem-table th {
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-dim);
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
  }

  .mem-table td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }

  .mem-table tr:hover td { background: var(--bg-hover); }

  .mem-table .key { color: var(--orchid); font-weight: 600; max-width: 200px; word-break: break-all; }
  .mem-table .val { color: var(--text); max-width: 400px; word-break: break-word; }
  .mem-table .score { color: var(--gold); font-weight: 600; }

  /* ── sections ── */
  .section { display: none; }
  .section.active { display: block; }

  /* ── toast ── */
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: var(--bg-card);
    border: 1px solid var(--green);
    border-radius: 6px;
    padding: 10px 16px;
    font-size: 12px;
    color: var(--green);
    opacity: 0;
    transform: translateY(10px);
    transition: all 0.2s;
    pointer-events: none;
    z-index: 100;
  }

  .toast.err { border-color: var(--rose); color: var(--rose); }
  .toast.show { opacity: 1; transform: translateY(0); }

  /* ── loading ── */
  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--purple);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    vertical-align: middle;
    margin-right: 6px;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .loading-overlay {
    display: none;
    position: absolute;
    inset: 0;
    background: rgba(14, 14, 26, 0.7);
    z-index: 10;
    justify-content: center;
    align-items: center;
  }

  /* ── scrollbar ── */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--gray); }

  /* ── secret mask ── */
  .secret-mask {
    color: var(--text-dim);
    font-style: italic;
    font-size: 11px;
  }
</style>
</head>
<body>

<div class="shell">
  <nav>
    <div class="brand">
      <h1>egirl</h1>
      <div class="sub">local-first ai agent</div>
    </div>
    <div class="nav-group">Overview</div>
    <a href="#" data-section="dashboard" class="active">Dashboard</a>
    <a href="#" data-section="chat">Chat</a>
    <div class="nav-group">Config</div>
    <a href="#" data-section="general">General</a>
    <a href="#" data-section="local">Local Model</a>
    <a href="#" data-section="routing">Routing</a>
    <a href="#" data-section="channels">Channels</a>
    <a href="#" data-section="memory-cfg">Memory</a>
    <a href="#" data-section="conversation">Conversation</a>
    <a href="#" data-section="safety">Safety</a>
    <a href="#" data-section="tasks-cfg">Tasks</a>
    <a href="#" data-section="thinking">Thinking</a>
    <a href="#" data-section="transcript">Transcript</a>
    <div class="nav-group">Explore</div>
    <a href="#" data-section="api">API Explorer</a>
    <a href="#" data-section="tools">Tools</a>
    <a href="#" data-section="memory">Memory Browser</a>
  </nav>

  <main>
    <!-- ═══════════════ DASHBOARD ═══════════════ -->
    <section id="sec-dashboard" class="section active">
      <h2>Dashboard</h2>
      <div class="card-row" id="status-cards">
        <div class="stat-card"><div class="label">Status</div><div class="value" id="dash-health">...</div></div>
        <div class="stat-card"><div class="label">Uptime</div><div class="value purple" id="dash-uptime">—</div></div>
        <div class="stat-card"><div class="label">Local Model</div><div class="value pink" id="dash-model">—</div></div>
        <div class="stat-card"><div class="label">Routing Default</div><div class="value" id="dash-routing">—</div></div>
      </div>

      <h3>Providers</h3>
      <div class="card">
        <div id="dash-providers"></div>
      </div>

      <h3>Usage Stats</h3>
      <div class="card-row" id="stats-cards">
        <div class="stat-card"><div class="label">Total Requests</div><div class="value purple" id="stat-total">0</div></div>
        <div class="stat-card"><div class="label">Local</div><div class="value ok" id="stat-local">0</div></div>
        <div class="stat-card"><div class="label">Remote</div><div class="value pink" id="stat-remote">0</div></div>
        <div class="stat-card"><div class="label">Escalations</div><div class="value gold" id="stat-esc">0</div></div>
      </div>
      <div class="card-row">
        <div class="stat-card"><div class="label">Tokens In / Out</div><div class="value" id="stat-tokens" style="font-size:14px">—</div></div>
        <div class="stat-card"><div class="label">API Cost</div><div class="value err" id="stat-cost">$0.00</div></div>
        <div class="stat-card"><div class="label">Estimated Savings</div><div class="value ok" id="stat-saved">$0.00</div></div>
      </div>
    </section>

    <!-- ═══════════════ CHAT ═══════════════ -->
    <section id="sec-chat" class="section">
      <h2>Chat</h2>
      <div class="chat-log" id="chat-log">
        <div style="color:var(--text-dim);font-style:italic">Send a message to test the agent...</div>
      </div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" placeholder="Type a message..." autocomplete="off">
        <button class="btn primary" id="chat-send">Send</button>
      </div>
    </section>

    <!-- ═══════════════ GENERAL CONFIG ═══════════════ -->
    <section id="sec-general" class="section">
      <h2>General</h2>
      <div class="card">
        <div class="field">
          <label>Theme</label>
          <div style="display:flex;gap:8px">
            <button class="btn theme-btn" data-theme="egirl" style="border-color:var(--purple);color:var(--purple)">egirl</button>
            <button class="btn theme-btn" data-theme="midnight" style="border-color:#5fafff;color:#5fafff">midnight</button>
            <button class="btn theme-btn" data-theme="neon" style="border-color:#00ff00;color:#00ff00">neon</button>
            <button class="btn theme-btn" data-theme="mono" style="border-color:#bcbcbc;color:#bcbcbc">mono</button>
          </div>
          <div class="hint">Active theme for CLI output. Restart required.</div>
        </div>
        <div class="field">
          <label>Workspace Path</label>
          <input type="text" id="cfg-workspace" placeholder="~/.egirl/workspace">
          <div class="hint">Root directory for memory, logs, sessions, skills</div>
        </div>
        <div class="field">
          <label>Skill Directories</label>
          <div class="tag-list" id="cfg-skill-dirs"></div>
          <div class="hint">Directories searched for skill definitions</div>
        </div>
      </div>
      <h3>Environment Keys</h3>
      <div class="card" id="env-keys-card">
        <div class="toggle-row">
          <div><div class="toggle-label">ANTHROPIC_API_KEY</div><div class="toggle-desc">Claude API access</div></div>
          <span class="badge" id="env-anthropic">—</span>
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">OPENAI_API_KEY</div><div class="toggle-desc">OpenAI / fallback provider</div></div>
          <span class="badge" id="env-openai">—</span>
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">DISCORD_TOKEN</div><div class="toggle-desc">Discord bot token</div></div>
          <span class="badge" id="env-discord">—</span>
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">GITHUB_TOKEN</div><div class="toggle-desc">GitHub integration</div></div>
          <span class="badge" id="env-github">—</span>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" onclick="saveConfig()">Save Configuration</button>
      </div>
    </section>

    <!-- ═══════════════ LOCAL MODEL ═══════════════ -->
    <section id="sec-local" class="section">
      <h2>Local Model</h2>
      <div class="card">
        <div class="field-row">
          <div class="field">
            <label>Endpoint</label>
            <input type="text" id="cfg-local-endpoint" placeholder="http://localhost:8080">
          </div>
          <div class="field">
            <label>Model Name</label>
            <input type="text" id="cfg-local-model" placeholder="qwen3-vl-32b">
            <div class="hint">Display/logging only — not sent to server</div>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Context Length</label>
            <input type="number" id="cfg-local-ctx" placeholder="32768">
          </div>
          <div class="field">
            <label>Max Concurrent</label>
            <input type="number" id="cfg-local-concurrent" placeholder="2">
          </div>
        </div>
      </div>

      <h3>Embeddings</h3>
      <div class="card">
        <div class="field-row">
          <div class="field">
            <label>Endpoint</label>
            <input type="text" id="cfg-emb-endpoint" placeholder="http://localhost:8082">
          </div>
          <div class="field">
            <label>Model</label>
            <input type="text" id="cfg-emb-model" placeholder="qwen3-vl-embedding-2b">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Dimensions</label>
            <input type="number" id="cfg-emb-dims" placeholder="2048">
          </div>
          <div class="field">
            <label>Multimodal</label>
            <div style="padding-top:4px">
              <label class="switch"><input type="checkbox" id="cfg-emb-multi"><span class="slider"></span></label>
              <span style="font-size:11px;color:var(--text-dim);margin-left:8px">Supports image embeddings</span>
            </div>
          </div>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" onclick="saveConfig()">Save Configuration</button>
        <button class="btn" onclick="pingLocal()">Test Connection</button>
      </div>
    </section>

    <!-- ═══════════════ ROUTING ═══════════════ -->
    <section id="sec-routing" class="section">
      <h2>Routing</h2>
      <div class="card">
        <div class="field">
          <label>Default Target</label>
          <select id="cfg-route-default">
            <option value="local">local</option>
            <option value="remote">remote</option>
          </select>
        </div>
        <div class="field">
          <label>Escalation Threshold <span class="range-val" id="cfg-esc-val">0.4</span></label>
          <input type="range" id="cfg-esc-threshold" min="0" max="1" step="0.05" value="0.4">
          <div class="hint">Confidence below this value triggers escalation to remote provider</div>
        </div>
        <div class="field">
          <label>Always Local</label>
          <div class="tag-list" id="cfg-always-local"></div>
          <input type="text" class="tag-input" id="cfg-always-local-input" placeholder="+ add task type">
        </div>
        <div class="field">
          <label>Always Remote</label>
          <div class="tag-list" id="cfg-always-remote"></div>
          <input type="text" class="tag-input" id="cfg-always-remote-input" placeholder="+ add task type">
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" onclick="saveConfig()">Save Configuration</button>
      </div>
    </section>

    <!-- ═══════════════ CHANNELS ═══════════════ -->
    <section id="sec-channels" class="section">
      <h2>Channels</h2>

      <h3>API Server</h3>
      <div class="card">
        <div class="field-row">
          <div class="field">
            <label>Port</label>
            <input type="number" id="cfg-api-port" placeholder="3000">
          </div>
          <div class="field">
            <label>Host</label>
            <input type="text" id="cfg-api-host" placeholder="127.0.0.1">
          </div>
        </div>
      </div>

      <h3>Discord</h3>
      <div class="card">
        <div class="field">
          <label>DISCORD_TOKEN</label>
          <span class="secret-mask" id="chan-discord-token">not loaded from env</span>
        </div>
        <div class="field">
          <label>Allowed Channels</label>
          <div class="tag-list" id="cfg-discord-channels"></div>
          <input type="text" class="tag-input" id="cfg-discord-channels-input" placeholder="+ add channel ID or 'dm'">
        </div>
        <div class="field">
          <label>Allowed Users</label>
          <div class="tag-list" id="cfg-discord-users"></div>
          <input type="text" class="tag-input" id="cfg-discord-users-input" placeholder="+ add user ID">
          <div class="hint">Empty = allow all users</div>
        </div>
        <div class="field">
          <label>Passive Channels</label>
          <div class="tag-list" id="cfg-discord-passive"></div>
          <input type="text" class="tag-input" id="cfg-discord-passive-input" placeholder="+ add channel ID">
          <div class="hint">Monitor and respond without being @mentioned</div>
        </div>
        <div class="field">
          <label>Batch Window (ms)</label>
          <input type="number" id="cfg-discord-batch" placeholder="3000">
          <div class="hint">Debounce interval for passive channel batching</div>
        </div>
      </div>

      <h3>Claude Code</h3>
      <div class="card">
        <div class="field-row">
          <div class="field">
            <label>Permission Mode</label>
            <select id="cfg-cc-perm">
              <option value="default">default</option>
              <option value="acceptEdits">acceptEdits</option>
              <option value="bypassPermissions">bypassPermissions</option>
              <option value="plan">plan</option>
            </select>
          </div>
          <div class="field">
            <label>Model Override</label>
            <input type="text" id="cfg-cc-model" placeholder="(none)">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Working Directory</label>
            <input type="text" id="cfg-cc-workdir" placeholder="(defaults to cwd)">
          </div>
          <div class="field">
            <label>Max Turns</label>
            <input type="number" id="cfg-cc-turns" placeholder="30">
          </div>
        </div>
      </div>

      <h3>XMPP</h3>
      <div class="card">
        <div class="field-row">
          <div class="field">
            <label>Service URL</label>
            <input type="text" id="cfg-xmpp-service" placeholder="xmpp://localhost:5222">
          </div>
          <div class="field">
            <label>Domain</label>
            <input type="text" id="cfg-xmpp-domain" placeholder="(derived from service)">
          </div>
        </div>
        <div class="field">
          <label>Resource</label>
          <input type="text" id="cfg-xmpp-resource" placeholder="(optional)">
        </div>
        <div class="field">
          <label>Allowed JIDs</label>
          <div class="tag-list" id="cfg-xmpp-jids"></div>
          <input type="text" class="tag-input" id="cfg-xmpp-jids-input" placeholder="+ add JID">
          <div class="hint">Empty = allow all</div>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" onclick="saveConfig()">Save Configuration</button>
      </div>
    </section>

    <!-- ═══════════════ MEMORY CONFIG ═══════════════ -->
    <section id="sec-memory-cfg" class="section">
      <h2>Memory Settings</h2>
      <div class="card">
        <div class="toggle-row">
          <div><div class="toggle-label">Proactive Retrieval</div><div class="toggle-desc">Auto-retrieve relevant memories during conversation</div></div>
          <label class="switch"><input type="checkbox" id="cfg-mem-proactive"><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">Auto Extract</div><div class="toggle-desc">Automatically extract facts from conversations</div></div>
          <label class="switch"><input type="checkbox" id="cfg-mem-extract"><span class="slider"></span></label>
        </div>
      </div>
      <div class="card">
        <div class="field">
          <label>Score Threshold <span class="range-val" id="cfg-mem-thresh-val">0.35</span></label>
          <input type="range" id="cfg-mem-threshold" min="0" max="1" step="0.05" value="0.35">
          <div class="hint">Minimum relevance score for memory retrieval</div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Max Results</label>
            <input type="number" id="cfg-mem-maxresults" placeholder="5">
          </div>
          <div class="field">
            <label>Max Tokens Budget</label>
            <input type="number" id="cfg-mem-budget" placeholder="2000">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Extraction Min Messages</label>
            <input type="number" id="cfg-mem-minmsg" placeholder="2">
          </div>
          <div class="field">
            <label>Extraction Max Per Turn</label>
            <input type="number" id="cfg-mem-maxperturn" placeholder="5">
          </div>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" onclick="saveConfig()">Save Configuration</button>
      </div>
    </section>

    <!-- ═══════════════ CONVERSATION ═══════════════ -->
    <section id="sec-conversation" class="section">
      <h2>Conversation</h2>
      <div class="card">
        <div class="toggle-row">
          <div><div class="toggle-label">Enabled</div><div class="toggle-desc">Store conversation history</div></div>
          <label class="switch"><input type="checkbox" id="cfg-conv-enabled"><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">Compact on Startup</div><div class="toggle-desc">Compact database when agent starts</div></div>
          <label class="switch"><input type="checkbox" id="cfg-conv-compact"><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">Context Compaction</div><div class="toggle-desc">Compress context window during long conversations</div></div>
          <label class="switch"><input type="checkbox" id="cfg-conv-compaction"><span class="slider"></span></label>
        </div>
      </div>
      <div class="card">
        <div class="field-row">
          <div class="field">
            <label>Max Age (days)</label>
            <input type="number" id="cfg-conv-maxage" placeholder="30">
          </div>
          <div class="field">
            <label>Max Messages</label>
            <input type="number" id="cfg-conv-maxmsg" placeholder="1000">
          </div>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" onclick="saveConfig()">Save Configuration</button>
      </div>
    </section>

    <!-- ═══════════════ SAFETY ═══════════════ -->
    <section id="sec-safety" class="section">
      <h2>Safety</h2>
      <div class="card">
        <div class="toggle-row">
          <div><div class="toggle-label">Safety System</div><div class="toggle-desc">Master switch for all safety features</div></div>
          <label class="switch"><input type="checkbox" id="cfg-safety-enabled"><span class="slider"></span></label>
        </div>
      </div>

      <h3>Command Filter</h3>
      <div class="card">
        <div class="toggle-row">
          <div><div class="toggle-label">Enabled</div><div class="toggle-desc">Block dangerous shell commands</div></div>
          <label class="switch"><input type="checkbox" id="cfg-safety-cmd"><span class="slider"></span></label>
        </div>
        <div class="field" style="margin-top:8px">
          <label>Blocked Patterns (regex)</label>
          <div class="tag-list" id="cfg-safety-cmd-patterns"></div>
          <input type="text" class="tag-input" id="cfg-safety-cmd-patterns-input" placeholder="+ add regex pattern">
          <div class="hint">Added on top of built-in blocklist</div>
        </div>
      </div>

      <h3>Path Sandbox</h3>
      <div class="card">
        <div class="toggle-row">
          <div><div class="toggle-label">Enabled</div><div class="toggle-desc">Restrict file operations to allowed directories</div></div>
          <label class="switch"><input type="checkbox" id="cfg-safety-path"><span class="slider"></span></label>
        </div>
        <div class="field" style="margin-top:8px">
          <label>Allowed Paths</label>
          <div class="tag-list" id="cfg-safety-allowed-paths"></div>
          <input type="text" class="tag-input" id="cfg-safety-allowed-paths-input" placeholder="+ add path">
        </div>
      </div>

      <h3>Sensitive Files</h3>
      <div class="card">
        <div class="toggle-row">
          <div><div class="toggle-label">Enabled</div><div class="toggle-desc">Block access to secrets and key files</div></div>
          <label class="switch"><input type="checkbox" id="cfg-safety-sens"><span class="slider"></span></label>
        </div>
        <div class="field" style="margin-top:8px">
          <label>Patterns (regex)</label>
          <div class="tag-list" id="cfg-safety-sens-patterns"></div>
          <input type="text" class="tag-input" id="cfg-safety-sens-patterns-input" placeholder="+ add file pattern">
        </div>
      </div>

      <h3>Audit Log</h3>
      <div class="card">
        <div class="toggle-row">
          <div><div class="toggle-label">Enabled</div><div class="toggle-desc">Log all tool calls to JSONL</div></div>
          <label class="switch"><input type="checkbox" id="cfg-safety-audit"><span class="slider"></span></label>
        </div>
        <div class="field" style="margin-top:8px">
          <label>Log Path</label>
          <input type="text" id="cfg-safety-audit-path" placeholder="{workspace}/audit.log">
        </div>
      </div>

      <h3>Confirmation</h3>
      <div class="card">
        <div class="toggle-row">
          <div><div class="toggle-label">Enabled</div><div class="toggle-desc">Require confirmation for destructive operations</div></div>
          <label class="switch"><input type="checkbox" id="cfg-safety-confirm"><span class="slider"></span></label>
        </div>
        <div class="field" style="margin-top:8px">
          <label>Tools Requiring Confirmation</label>
          <div class="tag-list" id="cfg-safety-confirm-tools"></div>
          <input type="text" class="tag-input" id="cfg-safety-confirm-tools-input" placeholder="+ add tool name">
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" onclick="saveConfig()">Save Configuration</button>
      </div>
    </section>

    <!-- ═══════════════ TASKS CONFIG ═══════════════ -->
    <section id="sec-tasks-cfg" class="section">
      <h2>Tasks</h2>
      <div class="card">
        <div class="toggle-row">
          <div><div class="toggle-label">Task System</div><div class="toggle-desc">Enable task scheduling and execution</div></div>
          <label class="switch"><input type="checkbox" id="cfg-tasks-enabled"><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">Discovery</div><div class="toggle-desc">Auto-discover and propose tasks</div></div>
          <label class="switch"><input type="checkbox" id="cfg-tasks-discovery"><span class="slider"></span></label>
        </div>
      </div>
      <div class="card">
        <div class="field-row">
          <div class="field">
            <label>Tick Interval (ms)</label>
            <input type="number" id="cfg-tasks-tick" placeholder="30000">
          </div>
          <div class="field">
            <label>Max Active Tasks</label>
            <input type="number" id="cfg-tasks-max" placeholder="20">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Task Timeout (ms)</label>
            <input type="number" id="cfg-tasks-timeout" placeholder="300000">
          </div>
          <div class="field">
            <label>Discovery Interval (ms)</label>
            <input type="number" id="cfg-tasks-disc-int" placeholder="1800000">
          </div>
        </div>
        <div class="field">
          <label>Idle Threshold (ms)</label>
          <input type="number" id="cfg-tasks-idle" placeholder="600000">
          <div class="hint">Time before the agent is considered idle</div>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" onclick="saveConfig()">Save Configuration</button>
      </div>
    </section>

    <!-- ═══════════════ THINKING ═══════════════ -->
    <section id="sec-thinking" class="section">
      <h2>Thinking</h2>
      <div class="card">
        <div class="field">
          <label>Level</label>
          <select id="cfg-think-level">
            <option value="off">off</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
          <div class="hint">Controls extended thinking for Anthropic and Qwen3 /think mode</div>
        </div>
        <div class="field">
          <label>Budget Tokens</label>
          <input type="number" id="cfg-think-budget" placeholder="(auto from level)">
          <div class="hint">Override thinking budget. Leave empty for automatic.</div>
        </div>
        <div class="toggle-row">
          <div><div class="toggle-label">Show Thinking</div><div class="toggle-desc">Display thinking output in CLI</div></div>
          <label class="switch"><input type="checkbox" id="cfg-think-show"><span class="slider"></span></label>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" onclick="saveConfig()">Save Configuration</button>
      </div>
    </section>

    <!-- ═══════════════ TRANSCRIPT ═══════════════ -->
    <section id="sec-transcript" class="section">
      <h2>Transcript</h2>
      <div class="card">
        <div class="toggle-row">
          <div><div class="toggle-label">Enabled</div><div class="toggle-desc">Save conversation transcripts to disk</div></div>
          <label class="switch"><input type="checkbox" id="cfg-transcript-enabled"><span class="slider"></span></label>
        </div>
        <div class="field" style="margin-top:8px">
          <label>Transcript Path</label>
          <input type="text" id="cfg-transcript-path" placeholder="{workspace}/transcripts">
          <div class="hint">Directory for saved transcripts</div>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" onclick="saveConfig()">Save Configuration</button>
      </div>
    </section>

    <!-- ═══════════════ API EXPLORER ═══════════════ -->
    <section id="sec-api" class="section">
      <h2>API Explorer</h2>
      <div id="api-endpoints"></div>
    </section>

    <!-- ═══════════════ TOOLS ═══════════════ -->
    <section id="sec-tools" class="section">
      <h2>Tools</h2>
      <div id="tools-list" style="color:var(--text-dim)">Loading tools...</div>
    </section>

    <!-- ═══════════════ MEMORY BROWSER ═══════════════ -->
    <section id="sec-memory" class="section">
      <h2>Memory Browser</h2>
      <div class="card">
        <div class="field-row">
          <div class="field" style="flex:1">
            <input type="text" id="mem-query" placeholder="Search memories...">
          </div>
          <div class="field" style="width:140px">
            <select id="mem-mode">
              <option value="hybrid">hybrid</option>
              <option value="text">text (FTS)</option>
              <option value="semantic">semantic</option>
            </select>
          </div>
        </div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn primary" onclick="searchMemory()">Search</button>
        </div>
      </div>
      <div id="mem-results"></div>

      <h3 style="margin-top:24px">Store Memory</h3>
      <div class="card">
        <div class="field-row">
          <div class="field">
            <label>Key</label>
            <input type="text" id="mem-set-key" placeholder="memory-key">
          </div>
          <div class="field">
            <label>Value</label>
            <input type="text" id="mem-set-val" placeholder="memory value">
          </div>
        </div>
        <div class="btn-row" style="margin-top:0">
          <button class="btn primary" onclick="storeMemory()">Store</button>
        </div>
      </div>
    </section>
  </main>
</div>

<div class="toast" id="toast"></div>

<script>
// ── State ──
let currentConfig = {};

// ── Navigation ──
document.querySelectorAll('nav a[data-section]').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const sec = link.dataset.section;
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
    document.getElementById('sec-' + sec).classList.add('active');
    link.classList.add('active');
  });
});

// ── Toast ──
function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '') + ' show';
  setTimeout(() => el.classList.remove('show'), 2500);
}

// ── API helpers ──
async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ── Tag list helper ──
function initTagList(listId, inputId, values) {
  const list = document.getElementById(listId);
  const input = document.getElementById(inputId);
  if (!list || !input) return;

  function render(vals) {
    list.innerHTML = '';
    vals.forEach((v, i) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.innerHTML = v + '<span class="tag-rm" data-i="' + i + '">&times;</span>';
      list.appendChild(tag);
    });
    list._values = vals;
  }

  render(values || []);

  list.addEventListener('click', e => {
    if (e.target.classList.contains('tag-rm')) {
      const vals = [...(list._values || [])];
      vals.splice(parseInt(e.target.dataset.i), 1);
      render(vals);
    }
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && input.value.trim()) {
      const vals = [...(list._values || []), input.value.trim()];
      render(vals);
      input.value = '';
    }
  });
}

function getTagValues(listId) {
  const list = document.getElementById(listId);
  return list ? (list._values || []) : [];
}

// ── Range slider sync ──
function syncRange(sliderId, valId) {
  const slider = document.getElementById(sliderId);
  const val = document.getElementById(valId);
  if (!slider || !val) return;
  slider.addEventListener('input', () => { val.textContent = slider.value; });
}

syncRange('cfg-esc-threshold', 'cfg-esc-val');
syncRange('cfg-mem-threshold', 'cfg-mem-thresh-val');

// ── Dashboard ──
async function loadDashboard() {
  try {
    const [health, status] = await Promise.all([
      api('/health'),
      api('/v1/status'),
    ]);

    // Health
    const hEl = document.getElementById('dash-health');
    hEl.textContent = health.status === 'ok' ? 'online' : 'error';
    hEl.className = 'value ' + (health.status === 'ok' ? 'ok' : 'err');

    // Uptime
    const secs = Math.floor(health.uptime);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    document.getElementById('dash-uptime').textContent =
      (h > 0 ? h + 'h ' : '') + m + 'm ' + s + 's';

    // Config summary
    const c = status.config;
    document.getElementById('dash-model').textContent = c.localModel;
    document.getElementById('dash-routing').textContent = c.routingDefault;

    // Providers
    const pEl = document.getElementById('dash-providers');
    const localStatus = '<span class="dot on"></span>Local: ' + status.providers.local;
    const remoteStatus = status.providers.remote
      ? '<span class="dot on"></span>Remote: ' + status.providers.remote
      : '<span class="dot off"></span>Remote: not configured';
    const embStatus = c.hasEmbeddings
      ? '<span class="dot on"></span>Embeddings: active'
      : '<span class="dot off"></span>Embeddings: not configured';
    const memStatus = c.hasMemory
      ? '<span class="dot on"></span>Memory: active'
      : '<span class="dot warn"></span>Memory: not initialized';
    pEl.innerHTML = [localStatus, remoteStatus, embStatus, memStatus]
      .map(s => '<div style="padding:4px 0">' + s + '</div>').join('');

    // Stats
    const st = status.stats;
    document.getElementById('stat-total').textContent = st.totalRequests;
    document.getElementById('stat-local').textContent = st.localRequests;
    document.getElementById('stat-remote').textContent = st.remoteRequests;
    document.getElementById('stat-esc').textContent = st.escalations;
    document.getElementById('stat-tokens').textContent =
      st.totalInputTokens.toLocaleString() + ' in / ' + st.totalOutputTokens.toLocaleString() + ' out';
    document.getElementById('stat-cost').textContent = '$' + st.totalCost.toFixed(4);
    document.getElementById('stat-saved').textContent = '$' + st.savedCost.toFixed(4);
  } catch (e) {
    document.getElementById('dash-health').textContent = 'offline';
    document.getElementById('dash-health').className = 'value err';
  }
}

// ── Load config into forms ──
async function loadConfig() {
  try {
    const data = await api('/v1/config');
    currentConfig = data;
    populateForms(data);
  } catch (e) {
    toast('Failed to load config: ' + e.message, true);
  }
}

function populateForms(c) {
  // General
  document.getElementById('cfg-workspace').value = c.workspace?.path || '';
  initTagList('cfg-skill-dirs', 'cfg-skill-dirs-input', c.skills?.dirs || []);

  // Theme buttons
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.style.fontWeight = btn.dataset.theme === c.theme ? '700' : '400';
    btn.style.opacity = btn.dataset.theme === c.theme ? '1' : '0.5';
  });

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentConfig.theme = btn.dataset.theme;
      document.querySelectorAll('.theme-btn').forEach(b => { b.style.fontWeight = '400'; b.style.opacity = '0.5'; });
      btn.style.fontWeight = '700';
      btn.style.opacity = '1';
    });
  });

  // Env keys
  setBadge('env-anthropic', c.remote?.hasAnthropic);
  setBadge('env-openai', c.remote?.hasOpenAI);
  setBadge('env-discord', c.channels?.hasDiscord);
  setBadge('env-github', c.hasGithub);

  if (c.channels?.hasDiscord) {
    document.getElementById('chan-discord-token').textContent = 'set from DISCORD_TOKEN';
    document.getElementById('chan-discord-token').style.color = 'var(--green)';
  }

  // Local
  document.getElementById('cfg-local-endpoint').value = c.local?.endpoint || '';
  document.getElementById('cfg-local-model').value = c.local?.model || '';
  document.getElementById('cfg-local-ctx').value = c.local?.contextLength || '';
  document.getElementById('cfg-local-concurrent').value = c.local?.maxConcurrent || '';

  // Embeddings
  if (c.local?.embeddings) {
    document.getElementById('cfg-emb-endpoint').value = c.local.embeddings.endpoint || '';
    document.getElementById('cfg-emb-model').value = c.local.embeddings.model || '';
    document.getElementById('cfg-emb-dims').value = c.local.embeddings.dimensions || '';
    document.getElementById('cfg-emb-multi').checked = c.local.embeddings.multimodal !== false;
  }

  // Routing
  document.getElementById('cfg-route-default').value = c.routing?.default || 'local';
  document.getElementById('cfg-esc-threshold').value = c.routing?.escalationThreshold ?? 0.4;
  document.getElementById('cfg-esc-val').textContent = c.routing?.escalationThreshold ?? 0.4;
  initTagList('cfg-always-local', 'cfg-always-local-input', c.routing?.alwaysLocal || []);
  initTagList('cfg-always-remote', 'cfg-always-remote-input', c.routing?.alwaysRemote || []);

  // Channels — API
  document.getElementById('cfg-api-port').value = c.channels?.api?.port || '';
  document.getElementById('cfg-api-host').value = c.channels?.api?.host || '';

  // Channels — Discord
  initTagList('cfg-discord-channels', 'cfg-discord-channels-input', c.channels?.discord?.allowedChannels || []);
  initTagList('cfg-discord-users', 'cfg-discord-users-input', c.channels?.discord?.allowedUsers || []);
  initTagList('cfg-discord-passive', 'cfg-discord-passive-input', c.channels?.discord?.passiveChannels || []);
  document.getElementById('cfg-discord-batch').value = c.channels?.discord?.batchWindowMs || '';

  // Channels — Claude Code
  document.getElementById('cfg-cc-perm').value = c.channels?.claudeCode?.permissionMode || 'default';
  document.getElementById('cfg-cc-model').value = c.channels?.claudeCode?.model || '';
  document.getElementById('cfg-cc-workdir').value = c.channels?.claudeCode?.workingDir || '';
  document.getElementById('cfg-cc-turns').value = c.channels?.claudeCode?.maxTurns || '';

  // Channels — XMPP
  document.getElementById('cfg-xmpp-service').value = c.channels?.xmpp?.service || '';
  document.getElementById('cfg-xmpp-domain').value = c.channels?.xmpp?.domain || '';
  document.getElementById('cfg-xmpp-resource').value = c.channels?.xmpp?.resource || '';
  initTagList('cfg-xmpp-jids', 'cfg-xmpp-jids-input', c.channels?.xmpp?.allowedJids || []);

  // Memory
  document.getElementById('cfg-mem-proactive').checked = c.memory?.proactiveRetrieval !== false;
  document.getElementById('cfg-mem-extract').checked = c.memory?.autoExtract !== false;
  document.getElementById('cfg-mem-threshold').value = c.memory?.scoreThreshold ?? 0.35;
  document.getElementById('cfg-mem-thresh-val').textContent = c.memory?.scoreThreshold ?? 0.35;
  document.getElementById('cfg-mem-maxresults').value = c.memory?.maxResults || '';
  document.getElementById('cfg-mem-budget').value = c.memory?.maxTokensBudget || '';
  document.getElementById('cfg-mem-minmsg').value = c.memory?.extractionMinMessages || '';
  document.getElementById('cfg-mem-maxperturn').value = c.memory?.extractionMaxPerTurn || '';

  // Conversation
  document.getElementById('cfg-conv-enabled').checked = c.conversation?.enabled !== false;
  document.getElementById('cfg-conv-compact').checked = c.conversation?.compactOnStartup !== false;
  document.getElementById('cfg-conv-compaction').checked = c.conversation?.contextCompaction !== false;
  document.getElementById('cfg-conv-maxage').value = c.conversation?.maxAgeDays || '';
  document.getElementById('cfg-conv-maxmsg').value = c.conversation?.maxMessages || '';

  // Safety
  document.getElementById('cfg-safety-enabled').checked = c.safety?.enabled !== false;
  document.getElementById('cfg-safety-cmd').checked = c.safety?.commandFilter?.enabled !== false;
  initTagList('cfg-safety-cmd-patterns', 'cfg-safety-cmd-patterns-input', c.safety?.commandFilter?.blockedPatterns || []);
  document.getElementById('cfg-safety-path').checked = c.safety?.pathSandbox?.enabled === true;
  initTagList('cfg-safety-allowed-paths', 'cfg-safety-allowed-paths-input', c.safety?.pathSandbox?.allowedPaths || []);
  document.getElementById('cfg-safety-sens').checked = c.safety?.sensitiveFiles?.enabled !== false;
  initTagList('cfg-safety-sens-patterns', 'cfg-safety-sens-patterns-input', c.safety?.sensitiveFiles?.patterns || []);
  document.getElementById('cfg-safety-audit').checked = c.safety?.auditLog?.enabled !== false;
  document.getElementById('cfg-safety-audit-path').value = c.safety?.auditLog?.path || '';
  document.getElementById('cfg-safety-confirm').checked = c.safety?.confirmation?.enabled === true;
  initTagList('cfg-safety-confirm-tools', 'cfg-safety-confirm-tools-input', c.safety?.confirmation?.tools || []);

  // Tasks
  document.getElementById('cfg-tasks-enabled').checked = c.tasks?.enabled !== false;
  document.getElementById('cfg-tasks-discovery').checked = c.tasks?.discoveryEnabled !== false;
  document.getElementById('cfg-tasks-tick').value = c.tasks?.tickIntervalMs || '';
  document.getElementById('cfg-tasks-max').value = c.tasks?.maxActiveTasks || '';
  document.getElementById('cfg-tasks-timeout').value = c.tasks?.taskTimeoutMs || '';
  document.getElementById('cfg-tasks-disc-int').value = c.tasks?.discoveryIntervalMs || '';
  document.getElementById('cfg-tasks-idle').value = c.tasks?.idleThresholdMs || '';

  // Thinking
  document.getElementById('cfg-think-level').value = c.thinking?.level || 'off';
  document.getElementById('cfg-think-budget').value = c.thinking?.budgetTokens || '';
  document.getElementById('cfg-think-show').checked = c.thinking?.showThinking !== false;

  // Transcript
  document.getElementById('cfg-transcript-enabled').checked = c.transcript?.enabled !== false;
  document.getElementById('cfg-transcript-path').value = c.transcript?.path || '';
}

function setBadge(id, isSet) {
  const el = document.getElementById(id);
  if (isSet) {
    el.className = 'badge ok';
    el.textContent = 'SET';
  } else {
    el.className = 'badge err';
    el.textContent = 'NOT SET';
  }
}

// ── Save config ──
async function saveConfig() {
  const payload = {
    theme: currentConfig.theme || 'egirl',
    workspace: { path: document.getElementById('cfg-workspace').value },
    local: {
      endpoint: document.getElementById('cfg-local-endpoint').value,
      model: document.getElementById('cfg-local-model').value,
      context_length: parseInt(document.getElementById('cfg-local-ctx').value) || 32768,
      max_concurrent: parseInt(document.getElementById('cfg-local-concurrent').value) || 2,
    },
    routing: {
      default: document.getElementById('cfg-route-default').value,
      escalation_threshold: parseFloat(document.getElementById('cfg-esc-threshold').value),
      always_local: getTagValues('cfg-always-local'),
      always_remote: getTagValues('cfg-always-remote'),
    },
    channels: {},
    conversation: {
      enabled: document.getElementById('cfg-conv-enabled').checked,
      max_age_days: parseInt(document.getElementById('cfg-conv-maxage').value) || 30,
      max_messages: parseInt(document.getElementById('cfg-conv-maxmsg').value) || 1000,
      compact_on_startup: document.getElementById('cfg-conv-compact').checked,
      context_compaction: document.getElementById('cfg-conv-compaction').checked,
    },
    memory: {
      proactive_retrieval: document.getElementById('cfg-mem-proactive').checked,
      score_threshold: parseFloat(document.getElementById('cfg-mem-threshold').value),
      max_results: parseInt(document.getElementById('cfg-mem-maxresults').value) || 5,
      max_tokens_budget: parseInt(document.getElementById('cfg-mem-budget').value) || 2000,
      auto_extract: document.getElementById('cfg-mem-extract').checked,
      extraction_min_messages: parseInt(document.getElementById('cfg-mem-minmsg').value) || 2,
      extraction_max_per_turn: parseInt(document.getElementById('cfg-mem-maxperturn').value) || 5,
    },
    safety: {
      enabled: document.getElementById('cfg-safety-enabled').checked,
      command_filter: {
        enabled: document.getElementById('cfg-safety-cmd').checked,
        blocked_patterns: getTagValues('cfg-safety-cmd-patterns'),
      },
      path_sandbox: {
        enabled: document.getElementById('cfg-safety-path').checked,
        allowed_paths: getTagValues('cfg-safety-allowed-paths'),
      },
      sensitive_files: {
        enabled: document.getElementById('cfg-safety-sens').checked,
        patterns: getTagValues('cfg-safety-sens-patterns'),
      },
      audit_log: {
        enabled: document.getElementById('cfg-safety-audit').checked,
        path: document.getElementById('cfg-safety-audit-path').value || undefined,
      },
      confirmation: {
        enabled: document.getElementById('cfg-safety-confirm').checked,
        tools: getTagValues('cfg-safety-confirm-tools'),
      },
    },
    tasks: {
      enabled: document.getElementById('cfg-tasks-enabled').checked,
      tick_interval_ms: parseInt(document.getElementById('cfg-tasks-tick').value) || 30000,
      max_active_tasks: parseInt(document.getElementById('cfg-tasks-max').value) || 20,
      task_timeout_ms: parseInt(document.getElementById('cfg-tasks-timeout').value) || 300000,
      discovery_enabled: document.getElementById('cfg-tasks-discovery').checked,
      discovery_interval_ms: parseInt(document.getElementById('cfg-tasks-disc-int').value) || 1800000,
      idle_threshold_ms: parseInt(document.getElementById('cfg-tasks-idle').value) || 600000,
    },
    skills: { dirs: getTagValues('cfg-skill-dirs') },
    thinking: {
      level: document.getElementById('cfg-think-level').value,
      budget_tokens: parseInt(document.getElementById('cfg-think-budget').value) || undefined,
      show_thinking: document.getElementById('cfg-think-show').checked,
    },
    transcript: {
      enabled: document.getElementById('cfg-transcript-enabled').checked,
      path: document.getElementById('cfg-transcript-path').value || undefined,
    },
  };

  // Embeddings (only include if endpoint is set)
  const embEndpoint = document.getElementById('cfg-emb-endpoint').value;
  if (embEndpoint) {
    payload.local.embeddings = {
      endpoint: embEndpoint,
      model: document.getElementById('cfg-emb-model').value,
      dimensions: parseInt(document.getElementById('cfg-emb-dims').value) || 2048,
      multimodal: document.getElementById('cfg-emb-multi').checked,
    };
  }

  // Channels — API
  const apiPort = document.getElementById('cfg-api-port').value;
  if (apiPort) {
    payload.channels.api = {
      port: parseInt(apiPort),
      host: document.getElementById('cfg-api-host').value || '127.0.0.1',
    };
  }

  // Channels — Discord
  const discChans = getTagValues('cfg-discord-channels');
  if (discChans.length > 0) {
    payload.channels.discord = {
      allowed_channels: discChans,
      allowed_users: getTagValues('cfg-discord-users'),
      passive_channels: getTagValues('cfg-discord-passive'),
      batch_window_ms: parseInt(document.getElementById('cfg-discord-batch').value) || 3000,
    };
  }

  // Channels — Claude Code
  const ccPerm = document.getElementById('cfg-cc-perm').value;
  if (ccPerm) {
    payload.channels.claude_code = {
      permission_mode: ccPerm,
    };
    const ccModel = document.getElementById('cfg-cc-model').value;
    if (ccModel) payload.channels.claude_code.model = ccModel;
    const ccDir = document.getElementById('cfg-cc-workdir').value;
    if (ccDir) payload.channels.claude_code.working_dir = ccDir;
    const ccTurns = document.getElementById('cfg-cc-turns').value;
    if (ccTurns) payload.channels.claude_code.max_turns = parseInt(ccTurns);
  }

  // Channels — XMPP
  const xmppSvc = document.getElementById('cfg-xmpp-service').value;
  if (xmppSvc) {
    payload.channels.xmpp = {
      service: xmppSvc,
      domain: document.getElementById('cfg-xmpp-domain').value || undefined,
      resource: document.getElementById('cfg-xmpp-resource').value || undefined,
      allowed_jids: getTagValues('cfg-xmpp-jids'),
    };
  }

  try {
    await api('/v1/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    toast('Configuration saved');
  } catch (e) {
    toast('Save failed: ' + e.message, true);
  }
}

// ── Ping local model ──
async function pingLocal() {
  try {
    const endpoint = document.getElementById('cfg-local-endpoint').value;
    const res = await fetch(endpoint + '/health');
    if (res.ok) toast('Local model is reachable');
    else toast('Local model returned ' + res.status, true);
  } catch (e) {
    toast('Cannot reach local model', true);
  }
}

// ── Chat ──
document.getElementById('chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});

async function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  const log = document.getElementById('chat-log');

  // Clear placeholder
  if (log.querySelector('[style]')) log.innerHTML = '';

  // User message
  log.innerHTML += '<div class="msg"><div class="role user">you</div><div class="body">' +
    escHtml(msg) + '</div></div>';
  log.scrollTop = log.scrollHeight;

  // Send
  const sendBtn = document.getElementById('chat-send');
  sendBtn.disabled = true;
  sendBtn.textContent = '...';

  try {
    const data = await api('/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });

    log.innerHTML += '<div class="msg"><div class="role agent">egirl</div><div class="body">' +
      escHtml(data.content) + '</div><div class="meta">' +
      data.target + ' / ' + data.provider + ' / ' +
      data.usage.input_tokens + ' in, ' + data.usage.output_tokens + ' out' +
      (data.escalated ? ' / escalated' : '') +
      '</div></div>';
  } catch (e) {
    log.innerHTML += '<div class="msg"><div class="role agent" style="color:var(--rose)">error</div><div class="body">' +
      escHtml(e.message) + '</div></div>';
  }

  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';
  log.scrollTop = log.scrollHeight;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── API Explorer ──
async function loadAPIExplorer() {
  try {
    const spec = await api('/openapi.json');
    const container = document.getElementById('api-endpoints');
    container.innerHTML = '';

    const groups = {};
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, info] of Object.entries(methods)) {
        const tag = info.tags?.[0] || 'Other';
        if (!groups[tag]) groups[tag] = [];
        groups[tag].push({ method: method.toUpperCase(), path, info });
      }
    }

    for (const [tag, endpoints] of Object.entries(groups)) {
      container.innerHTML += '<h3>' + tag + '</h3>';
      for (const ep of endpoints) {
        const id = 'ep-' + ep.method + '-' + ep.path.replace(/[^a-z0-9]/gi, '-');
        container.innerHTML +=
          '<div class="endpoint" id="' + id + '">' +
            '<div class="endpoint-header" onclick="toggleEndpoint(\\'' + id + '\\')">' +
              '<span class="method ' + ep.method.toLowerCase() + '">' + ep.method + '</span>' +
              '<span class="path">' + ep.path + '</span>' +
              '<span class="summary">' + (ep.info.summary || '') + '</span>' +
            '</div>' +
            '<div class="endpoint-body">' +
              '<div style="margin-bottom:8px;color:var(--text-dim);font-size:11px">' + (ep.info.description || ep.info.summary || '') + '</div>' +
              (ep.method !== 'GET' ? '<div class="field"><label>Request Body (JSON)</label><textarea id="' + id + '-body" rows="3">{}</textarea></div>' : '') +
              '<div class="btn-row" style="margin-top:8px"><button class="btn primary" onclick="tryEndpoint(\\'' + ep.method + '\\', \\'' + ep.path + '\\', \\'' + id + '\\')">Send</button></div>' +
              '<pre id="' + id + '-result" style="display:none"></pre>' +
            '</div>' +
          '</div>';
      }
    }
  } catch (e) {
    document.getElementById('api-endpoints').innerHTML =
      '<div style="color:var(--rose)">Failed to load API spec: ' + escHtml(e.message) + '</div>';
  }
}

function toggleEndpoint(id) {
  document.getElementById(id).classList.toggle('open');
}

async function tryEndpoint(method, path, id) {
  const resultEl = document.getElementById(id + '-result');
  resultEl.style.display = 'block';
  resultEl.textContent = 'Loading...';

  try {
    const opts = { method };
    if (method !== 'GET') {
      const bodyEl = document.getElementById(id + '-body');
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = bodyEl ? bodyEl.value : '{}';
    }

    const res = await fetch(path, opts);
    const status = res.status;
    const data = await res.json();

    const statusClass = status < 300 ? 's2xx' : status < 500 ? 's4xx' : 's5xx';
    resultEl.innerHTML = '<span class="response-status ' + statusClass + '">' + status + '</span>\\n' +
      escHtml(JSON.stringify(data, null, 2));
  } catch (e) {
    resultEl.innerHTML = '<span class="response-status s5xx">Error</span>\\n' + escHtml(e.message);
  }
}

// ── Tools ──
async function loadTools() {
  try {
    const data = await api('/v1/tools');
    const container = document.getElementById('tools-list');
    if (!data.tools || data.tools.length === 0) {
      container.innerHTML = '<div style="color:var(--text-dim)">No tools loaded</div>';
      return;
    }
    container.innerHTML = data.tools.map(t =>
      '<div class="endpoint">' +
        '<div class="endpoint-header" onclick="this.parentElement.classList.toggle(\\'open\\')">' +
          '<span class="method post" style="font-size:9px;min-width:36px">TOOL</span>' +
          '<span class="path">' + escHtml(t.name) + '</span>' +
          '<span class="summary">' + escHtml(t.description || '') + '</span>' +
        '</div>' +
        '<div class="endpoint-body">' +
          '<div class="field"><label>Arguments (JSON)</label><textarea id="tool-' + t.name + '-args" rows="3">{}</textarea></div>' +
          '<div class="btn-row" style="margin-top:8px"><button class="btn primary" onclick="execTool(\\'' + escHtml(t.name) + '\\')">Execute</button></div>' +
          '<pre id="tool-' + t.name + '-result" style="display:none"></pre>' +
        '</div>' +
      '</div>'
    ).join('');
  } catch (e) {
    document.getElementById('tools-list').innerHTML =
      '<div style="color:var(--rose)">Failed to load tools: ' + escHtml(e.message) + '</div>';
  }
}

async function execTool(name) {
  const resultEl = document.getElementById('tool-' + name + '-result');
  resultEl.style.display = 'block';
  resultEl.textContent = 'Executing...';

  try {
    const argsEl = document.getElementById('tool-' + name + '-args');
    const args = JSON.parse(argsEl.value);
    const data = await api('/v1/tools/' + encodeURIComponent(name) + '/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: args }),
    });

    resultEl.innerHTML = '<span class="response-status ' + (data.success ? 's2xx' : 's5xx') + '">' +
      (data.success ? 'success' : 'failed') + '</span>\\n' + escHtml(data.output || '');
  } catch (e) {
    resultEl.innerHTML = '<span class="response-status s5xx">Error</span>\\n' + escHtml(e.message);
  }
}

// ── Memory Browser ──
async function searchMemory() {
  const query = document.getElementById('mem-query').value.trim();
  if (!query) return;

  const mode = document.getElementById('mem-mode').value;
  const container = document.getElementById('mem-results');
  container.innerHTML = '<div class="spinner"></div> Searching...';

  try {
    const data = await api('/v1/memory/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, mode, limit: 20 }),
    });

    if (!data.results || data.results.length === 0) {
      container.innerHTML = '<div class="card" style="color:var(--text-dim)">No results</div>';
      return;
    }

    container.innerHTML = '<table class="mem-table"><thead><tr><th>Key</th><th>Value</th><th>Score</th><th>Match</th><th></th></tr></thead><tbody>' +
      data.results.map(r =>
        '<tr><td class="key">' + escHtml(r.key) + '</td>' +
        '<td class="val">' + escHtml(r.value.substring(0, 200)) + (r.value.length > 200 ? '...' : '') + '</td>' +
        '<td class="score">' + r.score.toFixed(3) + '</td>' +
        '<td><span class="badge info">' + r.matchType + '</span></td>' +
        '<td><button class="btn danger" style="padding:2px 8px;font-size:10px" onclick="deleteMemory(\\'' + escHtml(r.key) + '\\')">del</button></td></tr>'
      ).join('') +
      '</tbody></table>';
  } catch (e) {
    container.innerHTML = '<div class="card" style="color:var(--rose)">' + escHtml(e.message) + '</div>';
  }
}

async function storeMemory() {
  const key = document.getElementById('mem-set-key').value.trim();
  const val = document.getElementById('mem-set-val').value.trim();
  if (!key || !val) return toast('Key and value required', true);

  try {
    await api('/v1/memory/' + encodeURIComponent(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: val }),
    });
    toast('Memory stored: ' + key);
    document.getElementById('mem-set-key').value = '';
    document.getElementById('mem-set-val').value = '';
  } catch (e) {
    toast('Failed: ' + e.message, true);
  }
}

async function deleteMemory(key) {
  try {
    await api('/v1/memory/' + encodeURIComponent(key), { method: 'DELETE' });
    toast('Deleted: ' + key);
    searchMemory(); // refresh
  } catch (e) {
    toast('Failed: ' + e.message, true);
  }
}

// ── Init ──
loadDashboard();
loadConfig();
loadAPIExplorer();
loadTools();
setInterval(loadDashboard, 15000);
</script>
</body>
</html>`;
}
