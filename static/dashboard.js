// -- API base URL --
// Use ?api=http://host:port to point at a remote egirl instance
const API_BASE = new URLSearchParams(window.location.search).get('api') || '';

// -- State --
let currentConfig = {};

// -- Navigation --
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

// -- Toast --
function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '') + ' show';
  setTimeout(() => el.classList.remove('show'), 2500);
}

// -- API helpers --
async function api(path, opts) {
  const res = await fetch(API_BASE + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// -- Tag list helper --
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

// -- Range slider sync --
function syncRange(sliderId, valId) {
  const slider = document.getElementById(sliderId);
  const val = document.getElementById(valId);
  if (!slider || !val) return;
  slider.addEventListener('input', () => { val.textContent = slider.value; });
}

syncRange('cfg-esc-threshold', 'cfg-esc-val');
syncRange('cfg-mem-threshold', 'cfg-mem-thresh-val');

// -- Dashboard --
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

// -- Load config into forms --
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

  // Channels -- API
  document.getElementById('cfg-api-port').value = c.channels?.api?.port || '';
  document.getElementById('cfg-api-host').value = c.channels?.api?.host || '';

  // Channels -- Discord
  initTagList('cfg-discord-channels', 'cfg-discord-channels-input', c.channels?.discord?.allowedChannels || []);
  initTagList('cfg-discord-users', 'cfg-discord-users-input', c.channels?.discord?.allowedUsers || []);
  initTagList('cfg-discord-passive', 'cfg-discord-passive-input', c.channels?.discord?.passiveChannels || []);
  document.getElementById('cfg-discord-batch').value = c.channels?.discord?.batchWindowMs || '';

  // Channels -- Claude Code
  document.getElementById('cfg-cc-perm').value = c.channels?.claudeCode?.permissionMode || 'default';
  document.getElementById('cfg-cc-model').value = c.channels?.claudeCode?.model || '';
  document.getElementById('cfg-cc-workdir').value = c.channels?.claudeCode?.workingDir || '';
  document.getElementById('cfg-cc-turns').value = c.channels?.claudeCode?.maxTurns || '';

  // Channels -- XMPP
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

  // Tasks — Heartbeat
  document.getElementById('cfg-hb-enabled').checked = c.tasks?.heartbeat?.enabled !== false;
  document.getElementById('cfg-hb-schedule').value = c.tasks?.heartbeat?.schedule || '';
  document.getElementById('cfg-hb-hours').value = c.tasks?.heartbeat?.businessHours || '';

  // Thinking
  document.getElementById('cfg-think-level').value = c.thinking?.level || 'off';
  document.getElementById('cfg-think-budget').value = c.thinking?.budgetTokens || '';
  document.getElementById('cfg-think-show').checked = c.thinking?.showThinking !== false;

  // Transcript
  document.getElementById('cfg-transcript-enabled').checked = c.transcript?.enabled !== false;
  document.getElementById('cfg-transcript-path').value = c.transcript?.path || '';

  // GitHub
  setBadge('env-github-cfg', c.hasGithub);
  document.getElementById('cfg-gh-owner').value = c.github?.defaultOwner || '';
  document.getElementById('cfg-gh-repo').value = c.github?.defaultRepo || '';
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

// -- Save config --
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
      heartbeat: {
        enabled: document.getElementById('cfg-hb-enabled').checked,
        schedule: document.getElementById('cfg-hb-schedule').value || '*/30 * * * *',
        business_hours: document.getElementById('cfg-hb-hours').value || undefined,
      },
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

  // GitHub (only include if owner or repo is set)
  const ghOwner = document.getElementById('cfg-gh-owner').value;
  const ghRepo = document.getElementById('cfg-gh-repo').value;
  if (ghOwner || ghRepo) {
    payload.github = {
      default_owner: ghOwner || undefined,
      default_repo: ghRepo || undefined,
    };
  }

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

  // Channels -- API
  const apiPort = document.getElementById('cfg-api-port').value;
  if (apiPort) {
    payload.channels.api = {
      port: parseInt(apiPort),
      host: document.getElementById('cfg-api-host').value || '127.0.0.1',
    };
  }

  // Channels -- Discord
  const discChans = getTagValues('cfg-discord-channels');
  if (discChans.length > 0) {
    payload.channels.discord = {
      allowed_channels: discChans,
      allowed_users: getTagValues('cfg-discord-users'),
      passive_channels: getTagValues('cfg-discord-passive'),
      batch_window_ms: parseInt(document.getElementById('cfg-discord-batch').value) || 3000,
    };
  }

  // Channels -- Claude Code
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

  // Channels -- XMPP
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

// -- Ping local model --
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

// -- Chat --
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

// -- API Explorer --
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
            '<div class="endpoint-header" onclick="toggleEndpoint(\'' + id + '\')">' +
              '<span class="method ' + ep.method.toLowerCase() + '">' + ep.method + '</span>' +
              '<span class="path">' + ep.path + '</span>' +
              '<span class="summary">' + (ep.info.summary || '') + '</span>' +
            '</div>' +
            '<div class="endpoint-body">' +
              '<div style="margin-bottom:8px;color:var(--text-dim);font-size:11px">' + (ep.info.description || ep.info.summary || '') + '</div>' +
              (ep.method !== 'GET' ? '<div class="field"><label>Request Body (JSON)</label><textarea id="' + id + '-body" rows="3">{}</textarea></div>' : '') +
              '<div class="btn-row" style="margin-top:8px"><button class="btn primary" onclick="tryEndpoint(\'' + ep.method + '\', \'' + ep.path + '\', \'' + id + '\')">Send</button></div>' +
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

    const res = await fetch(API_BASE + path, opts);
    const status = res.status;
    const data = await res.json();

    const statusClass = status < 300 ? 's2xx' : status < 500 ? 's4xx' : 's5xx';
    resultEl.innerHTML = '<span class="response-status ' + statusClass + '">' + status + '</span>\n' +
      escHtml(JSON.stringify(data, null, 2));
  } catch (e) {
    resultEl.innerHTML = '<span class="response-status s5xx">Error</span>\n' + escHtml(e.message);
  }
}

// -- Tools --
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
        '<div class="endpoint-header" onclick="this.parentElement.classList.toggle(\'open\')">' +
          '<span class="method post" style="font-size:9px;min-width:36px">TOOL</span>' +
          '<span class="path">' + escHtml(t.name) + '</span>' +
          '<span class="summary">' + escHtml(t.description || '') + '</span>' +
        '</div>' +
        '<div class="endpoint-body">' +
          '<div class="field"><label>Arguments (JSON)</label><textarea id="tool-' + t.name + '-args" rows="3">{}</textarea></div>' +
          '<div class="btn-row" style="margin-top:8px"><button class="btn primary" onclick="execTool(\'' + escHtml(t.name) + '\')">Execute</button></div>' +
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
      (data.success ? 'success' : 'failed') + '</span>\n' + escHtml(data.output || '');
  } catch (e) {
    resultEl.innerHTML = '<span class="response-status s5xx">Error</span>\n' + escHtml(e.message);
  }
}

// -- Memory Browser --
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
        '<td><button class="btn danger" style="padding:2px 8px;font-size:10px" onclick="deleteMemory(\'' + escHtml(r.key) + '\')">del</button></td></tr>'
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

// -- Init --
loadDashboard();
loadConfig();
loadAPIExplorer();
loadTools();
setInterval(loadDashboard, 15000);
