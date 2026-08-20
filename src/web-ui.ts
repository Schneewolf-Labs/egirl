/**
 * A console for the HTTP API.
 *
 * The first version of this was a text box. That closed the "no way to reach an instance from a
 * phone" gap and nothing else -- it could have been talking to any agent, and everything the CLI
 * shows about what an instance *is* was missing.
 *
 * The endpoints for the rest already existed (`/memory`, `/tasks`, `/sessions`) or were one route
 * away (`/info`, `/prompt`). What was missing was somewhere to look at them. So this is four
 * panels over the same API rather than a chat client with extras bolted on, and the browser gets
 * the views a terminal is bad at: a searchable memory store and a scrollable system prompt.
 *
 * Still one self-contained string. A build step would buy component ergonomics and cost the
 * property that makes this maintainable -- that the whole surface is visible in one file.
 */

import type { Theme } from './ui/theme'

export function renderChatPage(opts: { name: string; theme: Theme; hasToken: boolean }): string {
  const { name, theme, hasToken } = opts
  const p = hex(theme.colors.primary)
  const s = hex(theme.colors.secondary)
  const a = hex(theme.colors.accent)

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<style>
:root{--p:${p};--s:${s};--a:${a};
  --bg:#0b0a12;--panel:#12111c;--fg:#e8e6f2;--dim:#8c86a8;--line:#221f33;--user:#1a1828}
@media(prefers-color-scheme:light){:root{--bg:#faf9fd;--panel:#f2f0f8;--fg:#1c1a26;--dim:#6a6580;--line:#e2dff0;--user:#eceaf6}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);height:100dvh;display:flex;flex-direction:column;
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--a)}
/* Header doubles as identity: which agent, which model, which box. */
header{flex:none;padding:.55rem .9rem;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:.6rem;
  background:linear-gradient(90deg,color-mix(in srgb,var(--p) 14%,transparent),transparent 60%)}
header b{color:var(--s);letter-spacing:.04em}
header .meta{color:var(--dim);font-size:.72rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header .sp{margin-left:auto;color:var(--dim);font-size:.72rem;white-space:nowrap}
nav{flex:none;display:flex;gap:.15rem;padding:0 .5rem;border-bottom:1px solid var(--line);overflow-x:auto}
nav button{background:none;border:0;border-bottom:2px solid transparent;color:var(--dim);
  padding:.5rem .75rem;font:inherit;font-size:.82rem;cursor:pointer;white-space:nowrap}
nav button[aria-selected=true]{color:var(--s);border-bottom-color:var(--s)}
main{flex:1;overflow:hidden;display:flex;flex-direction:column}
.tab{display:none;flex:1;overflow:hidden;flex-direction:column}
.tab[data-on]{display:flex}
#log{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.8rem}
.msg{max-width:min(46rem,94%);padding:.55rem .8rem;border-radius:.65rem;white-space:pre-wrap;overflow-wrap:anywhere}
.me{align-self:flex-end;background:var(--user)}
.her{align-self:flex-start;border:1px solid var(--line);border-left:2px solid var(--p);background:var(--panel)}
.sys{align-self:center;color:var(--dim);font-size:.78rem;font-style:italic}
.pending{color:var(--dim);font-style:italic}
.fail{border-left-color:#ff5f87;color:#ff9db4}
form{flex:none;display:flex;gap:.5rem;padding:.65rem;border-top:1px solid var(--line);
  padding-bottom:calc(.65rem + env(safe-area-inset-bottom))}
textarea,input[type=search]{flex:1;background:var(--user);color:var(--fg);border:1px solid var(--line);
  border-radius:.55rem;padding:.5rem .7rem;font:inherit;resize:none;max-height:9rem}
textarea:focus,input:focus{outline:none;border-color:var(--p)}
button.go{background:var(--p);color:#fff;border:0;border-radius:.55rem;padding:0 1rem;font:inherit;font-weight:600;cursor:pointer}
button.go:disabled{opacity:.45;cursor:default}
.pad{padding:1rem;overflow-y:auto;flex:1}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--panel);border:1px solid var(--line);
  border-radius:.5rem;padding:.8rem;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
table{width:100%;border-collapse:collapse;font-size:.85rem}
td{padding:.35rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
td:first-child{color:var(--dim);white-space:nowrap;width:1%;padding-right:1.2rem}
.mem{border:1px solid var(--line);border-left:2px solid var(--a);border-radius:.5rem;padding:.55rem .7rem;margin-bottom:.55rem;background:var(--panel)}
.mem .k{color:var(--a);font-size:.78rem;font-family:ui-monospace,monospace}
.mem .s{color:var(--dim);font-size:.72rem;float:right}
.row{display:flex;gap:.5rem;padding:.65rem;border-bottom:1px solid var(--line);flex:none}
.chip{display:inline-block;padding:.1rem .45rem;border-radius:.3rem;background:var(--user);color:var(--dim);font-size:.72rem;margin-right:.3rem}
/* Session picker: which conversation this window is, and a way to be a different one. */
.sessrow{display:flex;gap:.4rem;padding:.45rem .65rem;border-bottom:1px solid var(--line);flex:none;align-items:center}
.sessrow select{flex:1;min-width:0;background:var(--user);color:var(--fg);border:1px solid var(--line);
  border-radius:.45rem;padding:.3rem .5rem;font:inherit;font-size:.8rem}
.sessrow select:focus{outline:none;border-color:var(--p)}
.sessrow button{background:none;border:1px solid var(--line);border-radius:.45rem;color:var(--dim);
  padding:.25rem .6rem;font:inherit;font-size:.8rem;cursor:pointer;white-space:nowrap}
.sessrow button:hover{color:var(--s);border-color:var(--s)}
.queued{opacity:.7}
.queued::before{content:'♡ queued · ';color:var(--s);font-style:italic;font-size:.78rem}
</style></head><body>
<header><b>${esc(name)}</b><span class="meta" id="hmeta">connecting…</span><span class="sp" id="status">ready</span></header>
<nav id="tabs">
  <button data-tab="chat" aria-selected="true">chat</button>
  <button data-tab="memory" aria-selected="false">memory</button>
  <button data-tab="prompt" aria-selected="false">prompt</button>
  <button data-tab="info" aria-selected="false">info</button>
</nav>
<main>
  <section class="tab" data-name="chat" data-on>
    <div class="sessrow"><select id="sess" title="session"></select><button id="snew" title="start a fresh conversation">+ new</button></div>
    <div id="log"></div>
    <form id="f"><textarea id="m" rows="1" placeholder="Message ${esc(name)}…" autofocus></textarea><button class="go" id="b">Send</button></form>
  </section>

  <section class="tab" data-name="memory">
    <div class="row"><input type="search" id="mq" placeholder="Search memories…"><button class="go" id="mgo">Search</button></div>
    <div class="pad" id="mres"><p style="color:var(--dim)">Search the agent's long-term memory. Results are ranked by relevance.</p></div>
  </section>

  <section class="tab" data-name="prompt">
    <div class="pad"><pre id="sysprompt">loading…</pre></div>
  </section>

  <section class="tab" data-name="info">
    <div class="pad"><table id="infotbl"></table></div>
  </section>
</main>
<script>
const $=id=>document.getElementById(id);
const log=$('log'),f=$('f'),m=$('m'),b=$('b'),status=$('status'),sessSel=$('sess');
let sid=localStorage.getItem('egirl-sid')||('web:'+Math.random().toString(36).slice(2,10));
localStorage.setItem('egirl-sid',sid);
${hasToken ? `let tok=localStorage.getItem('egirl-token');if(!tok){tok=prompt('API token');if(tok)localStorage.setItem('egirl-token',tok)}` : 'const tok=null;'}
const H=()=>{const h={'Content-Type':'application/json'};if(tok)h['Authorization']='Bearer '+tok;return h};
const esc=t=>String(t??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// Tabs are plain show/hide. Loaded lazily so opening the page does not fetch the system prompt
// and the whole memory store before anything has been typed.
const loaded={};
$('tabs').onclick=e=>{
  const t=e.target.dataset.tab; if(!t) return;
  for(const btn of $('tabs').children) btn.setAttribute('aria-selected', String(btn.dataset.tab===t));
  for(const s of document.querySelectorAll('.tab')) s.toggleAttribute('data-on', s.dataset.name===t);
  if(!loaded[t]){loaded[t]=1; if(t==='prompt')loadPrompt(); if(t==='info')loadInfo()}
};

function add(text,cls){const d=document.createElement('div');d.className='msg '+cls;d.textContent=text;
  log.appendChild(d);log.scrollTop=log.scrollHeight;return d}

// ---- Sessions -------------------------------------------------------------
// The picker shows every conversation the store knows, from every channel -- the point is
// picking up on the web what was started in the CLI. Times render as "how long ago" because
// that is the question a picker answers: which of these was I just talking to?
function ago(ts){if(!ts)return'';const s=(Date.now()-ts)/1000;
  if(s<90)return'just now';if(s<3600)return Math.round(s/60)+'m ago';
  if(s<86400)return Math.round(s/3600)+'h ago';return Math.round(s/86400)+'d ago'}

async function loadSessions(){
  try{
    const d=await (await fetch('sessions',{headers:H()})).json();
    const list=d.sessions||[];
    if(!list.some(x=>x.id===sid)) list.unshift({id:sid,channel:'web',message_count:0});
    sessSel.innerHTML=list.map(x=>{
      const label=x.id+' · '+(x.message_count||0)+' msg'+(x.last_active_at?' · '+ago(x.last_active_at):'')+(x.busy?' · working…':'');
      return '<option value="'+esc(x.id)+'"'+(x.id===sid?' selected':'')+'>'+esc(label)+'</option>';
    }).join('');
  }catch(e){/* the picker failing must not take the chat down with it */}
}

// History as the conversation looked, not as the model sees it: tool plumbing and injected
// [System:] notes are context, and a transcript full of them buries what was actually said.
function historyView(msgs){
  const out=[];
  for(const msg of msgs||[]){
    if(msg.role==='user'){
      if(msg.content.startsWith('[')||msg.content.includes('<tool_response>'))continue;
      out.push({who:'me',text:msg.content});
    }else if(msg.role==='assistant'){
      const text=msg.content.replace(/<tool_call>[\\s\\S]*?(<\\/tool_call>|$)/g,'').trim();
      if(text)out.push({who:'her',text});
    }
  }
  return out;
}

async function loadHistory(){
  log.innerHTML='';
  try{
    const r=await fetch('sessions/'+encodeURIComponent(sid),{headers:H()});
    if(!r.ok)return;
    const d=await r.json();
    for(const msg of historyView(d.messages))add(msg.text,msg.who);
    if(d.has_summary)add('older messages are compacted into a summary','sys');
    if(!log.children.length)add('new conversation — say hi','sys');
  }catch(e){add('could not load history: '+(e.message||e),'sys')}
}

function switchSession(id){
  sid=id;localStorage.setItem('egirl-sid',sid);
  loaded.prompt=0;$('sysprompt').textContent='loading…';
  loadHistory();m.focus();
}
sessSel.onchange=()=>switchSession(sessSel.value);
$('snew').onclick=()=>{
  const id='web:'+Math.random().toString(36).slice(2,10);
  const o=document.createElement('option');o.value=id;o.textContent=id+' · 0 msg';
  sessSel.prepend(o);sessSel.value=id;switchSession(id);
};

m.addEventListener('input',()=>{m.style.height='auto';m.style.height=Math.min(m.scrollHeight,144)+'px'});
m.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();f.requestSubmit()}});

// ---- Sending --------------------------------------------------------------
// Send stays enabled while she works: the server queues per session, so typing ahead is the
// same contract as the CLI -- later messages wait their turn instead of interleaving. Each
// send keeps its own placeholder, so replies land in the bubbles that asked for them.
let inflight=0;
f.onsubmit=async e=>{
  e.preventDefault();
  const text=m.value.trim(); if(!text) return;
  const mine=add(text,'me'); m.value=''; m.style.height='auto';
  const wasBusy=inflight>0; inflight++;
  if(wasBusy)mine.classList.add('queued');
  status.textContent=wasBusy?'queued ('+inflight+')':'thinking…';
  const ph=add('…','her pending'); const t0=Date.now();
  try{
    const r=await fetch('chat',{method:'POST',headers:H(),body:JSON.stringify({message:text,session_id:sid})});
    if(!r.ok) throw new Error('HTTP '+r.status+(r.status===401?' — bad or missing token':''));
    const d=await r.json();
    mine.classList.remove('queued');
    ph.className='msg her'; ph.textContent=d.content||'(empty reply)';
    status.textContent=Math.round((Date.now()-t0)/1000)+'s · '+(d.output_tokens??'?')+' tok · '+(d.turns??'?')+' turns';
  }catch(err){
    // Rendered in place: a local model can take minutes, and a swallowed error is
    // indistinguishable from one that is merely slow.
    ph.className='msg her fail'; ph.textContent=String(err.message||err); status.textContent='failed';
  }finally{ inflight--; m.focus() }
};

async function loadPrompt(){
  try{
    const r=await fetch('prompt?session_id='+encodeURIComponent(sid),{headers:H()});
    const d=await r.json();
    $('sysprompt').textContent=d.systemPrompt||'(empty)';
    $('sysprompt').insertAdjacentHTML('beforebegin','<p style="color:var(--dim);font-size:.8rem">'+d.length+' characters — IDENTITY, SOUL, AGENTS, USER and tool descriptions as the model receives them.</p>');
  }catch(e){ $('sysprompt').textContent='failed to load: '+e.message }
}

async function loadInfo(){
  try{
    const d=await (await fetch('info',{headers:H()})).json();
    const rows=[
      ['name',d.name],['instance',d.instance],['persona',d.persona],['profile',d.profile],['theme',d.theme],
      ['model',d.model],['endpoint',d.endpoint],['context',d.contextLength?d.contextLength.toLocaleString()+' tokens':null],
      ['auxiliary',d.auxiliary?d.auxiliary.model+' @ '+d.auxiliary.endpoint:'none — compaction runs on the operator'],
      ['embeddings',d.embeddings?d.embeddings.model+' ('+d.embeddings.dimensions+'d)':'none — memory disabled'],
      ['memory',d.memory?'enabled':'disabled'],
      ['code agent',d.codeAgent||'off'],['thinking',d.thinking],
      ['permissions',d.permissions?d.permissions.mode+' · default '+d.permissions.defaultAction:null],
      ['workspace',d.workspace],
    ];
    $('infotbl').innerHTML=rows.filter(r=>r[1]!=null&&r[1]!=='')
      .map(r=>'<tr><td>'+esc(r[0])+'</td><td>'+esc(r[1])+'</td></tr>').join('');
    const tools=d.tools?Object.entries(d.tools).filter(([,v])=>v).map(([k])=>'<span class="chip">'+esc(k)+'</span>').join(''):'';
    if(tools) $('infotbl').insertAdjacentHTML('beforeend','<tr><td>tools</td><td>'+tools+'</td></tr>');
    $('hmeta').textContent=[d.model,d.instance].filter(Boolean).join(' · ');
  }catch(e){ $('infotbl').innerHTML='<tr><td>error</td><td>'+esc(e.message)+'</td></tr>' }
}

async function searchMem(){
  const q=$('mq').value.trim(); if(!q) return;
  $('mres').innerHTML='<p style="color:var(--dim)">searching…</p>';
  try{
    const r=await fetch('memory?limit=25&q='+encodeURIComponent(q),{headers:H()});
    if(r.status===503){$('mres').innerHTML='<p style="color:var(--dim)">Memory is disabled on this instance — no embeddings configured.</p>';return}
    const d=await r.json();
    if(!d.results||!d.results.length){$('mres').innerHTML='<p style="color:var(--dim)">nothing found</p>';return}
    $('mres').innerHTML=d.results.map(x=>
      '<div class="mem"><span class="s">'+(x.score!=null?x.score.toFixed(3):'')+'</span>'+
      '<div class="k">'+esc(x.key)+(x.category?' · '+esc(x.category):'')+'</div>'+
      '<div>'+esc(x.value)+'</div></div>').join('');
  }catch(e){ $('mres').innerHTML='<p style="color:#ff9db4">'+esc(e.message)+'</p>' }
}
$('mgo').onclick=searchMem;
$('mq').addEventListener('keydown',e=>{if(e.key==='Enter')searchMem()});

// Identity is fetched immediately even though its tab is lazy: the header should say what you
// are talking to before you say anything to it.
loadInfo(); loaded.info=1;
// The conversation you were having is the first thing the page should show, not an empty box.
loadSessions(); loadHistory();
// Sessions started elsewhere (the CLI, a peer) appear without a reload; 30s is fresh enough
// for a picker and cheap enough to leave running in a background tab.
setInterval(loadSessions,30000);
</script></body></html>`
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

/**
 * The CLI palette is 256-colour ANSI; a browser needs hex. Mapped through the standard xterm cube
 * so an instance's colours are the ones its terminal shows rather than an approximation.
 */
function hex(ansi: string): string {
  const m = /38;5;(\d+)m/.exec(ansi)
  if (!m || !m[1]) return '#af5fd7'
  const n = Number(m[1])
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `#${v.toString(16).padStart(2, '0').repeat(3)}`
  }
  if (n >= 16) {
    const c = n - 16
    const steps = [0, 95, 135, 175, 215, 255]
    const r = steps[Math.floor(c / 36)] ?? 0
    const g = steps[Math.floor((c % 36) / 6)] ?? 0
    const b = steps[c % 6] ?? 0
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  }
  return '#af5fd7'
}
