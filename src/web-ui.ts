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

export function renderChatPage(opts: {
  name: string
  theme: Theme
  hasToken: boolean
  /**
   * Per-response CSP nonce. The page's own inline script carries it; markup injected into the
   * DOM afterwards cannot, so the browser refuses to run it. This is the layer beneath escaping,
   * and it covers inline event handlers -- exactly the shape the markdown XSS took.
   */
  nonce?: string
}): string {
  const { name, theme, hasToken, nonce } = opts
  const p = ansiToHex(theme.colors.primary)
  const s = ansiToHex(theme.colors.secondary)
  const a = ansiToHex(theme.colors.accent)

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<link rel="manifest" href="manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${esc(name)}">
<style>
:root{--p:${p};--s:${s};--a:${a};
  --bg:#0b0a12;--panel:#12111c;--fg:#e8e6f2;--dim:#8c86a8;--line:#221f33;--user:#1a1828}
@media(prefers-color-scheme:light){:root{--bg:#faf9fd;--panel:#f2f0f8;--fg:#1c1a26;--dim:#6a6580;--line:#e2dff0;--user:#eceaf6}}
*{box-sizing:border-box}
/* the hidden attribute must beat class-level display:flex/grid — else toggled-off panels (the
   task form, the attach row, the inbox badge) stay visible. */
[hidden]{display:none!important}
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
/* Live turn: reasoning streams into .think (most of a local model's output is thinking), tool
   activity into .toolline, the answer into .body. On completion .think collapses to a toggle. */
.think{color:var(--dim);font-size:.83rem;border-left:2px solid var(--line);padding-left:.6rem;
  margin-bottom:.45rem;white-space:pre-wrap;overflow-wrap:anywhere;max-height:9rem;overflow-y:auto}
.think.done{max-height:none;overflow:visible;border-left-color:color-mix(in srgb,var(--a) 55%,var(--line))}
.thead{cursor:pointer;user-select:none;color:var(--dim);font-size:.76rem}
.thead:hover{color:var(--s)}
.tbody{margin-top:.35rem;white-space:pre-wrap;overflow-wrap:anywhere}
.toolline{color:var(--a);font-size:.77rem;font-style:italic;margin-bottom:.4rem}
.body{white-space:pre-wrap;overflow-wrap:anywhere}
.cursor::after{content:'▋';color:var(--p);animation:blink 1s step-start infinite;margin-left:1px}
@keyframes blink{50%{opacity:0}}
/* Rendered markdown: her replies are full of code and structure — render it, but only once the
   turn is done (streaming stays raw text for speed). */
.body.md{white-space:normal}
.body.md .p{margin:.25rem 0}
.body.md .p:first-child,.body.md h3:first-child,.body.md h4:first-child{margin-top:0}
.body.md h3,.body.md h4,.body.md h5{margin:.6rem 0 .3rem;line-height:1.3;color:var(--s)}
.body.md h3{font-size:1.06rem}.body.md h4{font-size:.98rem}.body.md h5{font-size:.9rem}
.body.md ul,.body.md ol{margin:.3rem 0;padding-left:1.35rem}
.body.md li{margin:.13rem 0}
.body.md code{background:var(--user);border-radius:.3rem;padding:.05rem .32rem;
  font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.body.md pre{position:relative;margin:.5rem 0}
.body.md pre code{background:none;padding:0}
.body.md pre[data-lang]::before{content:attr(data-lang);position:absolute;top:.3rem;left:.6rem;
  color:var(--dim);font-size:.66rem;text-transform:uppercase;letter-spacing:.05em}
.body.md pre[data-lang]{padding-top:1.5rem}
.body.md pre .copy{position:absolute;top:.35rem;right:.35rem;background:var(--user);border:1px solid var(--line);
  color:var(--dim);border-radius:.3rem;font:inherit;font-size:.68rem;padding:.1rem .45rem;cursor:pointer;opacity:0;transition:opacity .12s}
.body.md pre:hover .copy{opacity:1}
.body.md pre .copy:hover{color:var(--s);border-color:var(--s)}
.body.md blockquote{border-left:2px solid var(--line);margin:.4rem 0;padding-left:.7rem;color:var(--dim)}
.body.md a{color:var(--a)}
.body.md hr{border:0;border-top:1px solid var(--line);margin:.6rem 0}
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
.clip{background:none;border:1px solid var(--line);border-radius:.55rem;color:var(--dim);width:2.3rem;font:inherit;font-size:1.1rem;cursor:pointer;flex:none}
.clip:hover{color:var(--s);border-color:var(--s)}
.attachrow{display:flex;gap:.4rem;padding:.4rem .65rem 0;flex-wrap:wrap}
.attachrow img{height:3.2rem;border-radius:.4rem;border:1px solid var(--line)}
.attachrow .x{position:absolute;top:-.4rem;right:-.4rem;background:var(--bg);border:1px solid var(--line);border-radius:50%;width:1.1rem;height:1.1rem;line-height:1;font-size:.7rem;color:var(--dim);cursor:pointer;padding:0}
.attachrow .thumb{position:relative}
.msg img{max-width:14rem;border-radius:.45rem;display:block;margin-top:.3rem}
.queued::before{content:'♡ queued · ';color:var(--s);font-style:italic;font-size:.78rem}
/* In a peer session the right-hand side is another agent, not you. Say which. */
.me[data-from]::before{content:'⇄ ' attr(data-from);display:block;color:var(--s);font-size:.72rem;
  margin-bottom:.25rem;letter-spacing:.03em}
/* ---- Tasks & inbox: the autonomy surface --------------------------------- */
/* A task's stored status ('active') can't say whether it's idle or mid-run; the server's live
   running flag does, and drives the pulse + whether "stop" is offered. */
.tasklist{padding:.7rem;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:.5rem}
.task{border:1px solid var(--line);border-left:2px solid var(--line);border-radius:.55rem;
  background:var(--panel);padding:.6rem .7rem;transition:border-color .15s}
.task.run{border-left-color:var(--p)}
.task.await{border-left-color:var(--a)}
.task.fail{border-left-color:#ff5f87}
.task .top{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.task .nm{font-weight:600;overflow-wrap:anywhere}
.task .meta{color:var(--dim);font-size:.73rem;margin-top:.35rem;display:flex;gap:.9rem;flex-wrap:wrap}
.task .acts{display:flex;gap:.35rem;margin-top:.55rem;flex-wrap:wrap}
.task .acts button{background:none;border:1px solid var(--line);border-radius:.4rem;color:var(--dim);
  padding:.22rem .6rem;font:inherit;font-size:.76rem;cursor:pointer;transition:color .12s,border-color .12s}
.task .acts button:hover{color:var(--s);border-color:var(--s)}
.task .acts button.stop:hover{color:#ffcf7a;border-color:#ffb347}
.task .acts button.danger:hover{color:#ff9db4;border-color:#ff5f87}
.task .acts button:disabled{opacity:.4;cursor:default}
.badge{display:inline-flex;align-items:center;gap:.32rem;padding:.12rem .5rem;border-radius:.35rem;
  font-size:.68rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:var(--user);color:var(--dim)}
.badge.active{color:var(--s)}
.badge.running{color:var(--p)}
.badge.awaiting{color:var(--a)}
.badge.failed{color:#ff9db4}
.badge .dot{width:.5rem;height:.5rem;border-radius:50%;background:currentColor;flex:none}
.badge.running .dot{animation:pulse 1.1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
.warn{color:#ff9db4}
.empty{color:var(--dim);text-align:center;padding:2.5rem 1rem;font-size:.86rem;line-height:1.7}
.count{display:inline-block;min-width:1.05rem;text-align:center;background:var(--a);color:var(--bg);
  border-radius:.7rem;font-size:.64rem;padding:.02rem .32rem;margin-left:.2rem;font-weight:700;vertical-align:.06rem}
.ask .q{white-space:pre-wrap;overflow-wrap:anywhere;margin:.45rem 0 .6rem;color:var(--fg)}
.ask .rep{display:flex;gap:.4rem}
.ask textarea{min-height:2.5rem}
/* Click a task's header row to expand its prompt + recent runs. */
.task .top{cursor:pointer}
.task.open{border-color:color-mix(in srgb,var(--p) 40%,var(--line))}
.detail{margin-top:.6rem;border-top:1px solid var(--line);padding-top:.55rem;display:flex;flex-direction:column;gap:.55rem}
.dlabel{color:var(--dim);font-size:.67rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.2rem}
.detail .pbody{max-height:9rem;overflow:auto;font-size:11.5px}
.detail .run{border-left:2px solid var(--line);padding-left:.6rem}
.detail .runhd{color:var(--dim);font-size:.73rem;display:flex;gap:.5rem;align-items:center;margin-bottom:.2rem;flex-wrap:wrap}
.detail .runbody{font-size:.8rem;white-space:pre-wrap;overflow-wrap:anywhere;max-height:7rem;overflow:auto}
.dim{color:var(--dim)}
/* Create-task form (POST /tasks). */
.tbar{display:flex;justify-content:flex-end;padding:.5rem .7rem 0;flex:none}
button.mini{background:none;border:1px solid var(--line);border-radius:.45rem;color:var(--dim);
  padding:.3rem .7rem;font:inherit;font-size:.8rem;cursor:pointer;transition:color .12s,border-color .12s}
button.mini:hover{color:var(--s);border-color:var(--s)}
.taskform{display:flex;flex-direction:column;gap:.45rem;padding:.6rem .7rem;margin:.5rem .7rem 0;flex:none;
  border:1px solid var(--line);border-radius:.55rem;background:var(--panel)}
.taskform input,.taskform textarea,.taskform select{background:var(--user);color:var(--fg);
  border:1px solid var(--line);border-radius:.45rem;padding:.42rem .55rem;font:inherit;font-size:.85rem}
.taskform input:focus,.taskform textarea:focus,.taskform select:focus{outline:none;border-color:var(--p)}
.taskform textarea{resize:vertical;min-height:3.5rem}
.taskform .frow{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.taskform .frow .go{margin-left:auto}
.chk{display:flex;align-items:center;gap:.35rem;color:var(--dim);font-size:.8rem;cursor:pointer}
/* Settings: live session controls above the read-only instance facts. */
.sect{margin-bottom:1.4rem}
.sect .frow{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:.6rem}
.sect select{background:var(--user);color:var(--fg);border:1px solid var(--line);
  border-radius:.45rem;padding:.32rem .5rem;font:inherit;font-size:.82rem}
.sect select:focus{outline:none;border-color:var(--p)}
button.mini.danger:hover{color:#ff9db4;border-color:#ff5f87}
/* Context meter: the number worth watching, since an agent degrades well before it fills. */
.ctxwrap{margin-top:.15rem}
.ctxbar{height:.55rem;background:var(--user);border-radius:.3rem;overflow:hidden;border:1px solid var(--line)}
.ctxbar span{display:block;height:100%;width:0;background:var(--p);transition:width .3s,background .3s}
.ctxbar span.warn2{background:#ffb347}
.ctxbar span.crit{background:#ff5f87}
.ctxnums{color:var(--dim);font-size:.76rem;margin-top:.35rem;font-variant-numeric:tabular-nums}
/* ---- polish: themed scrollbars, honoured motion prefs -------------------- */
*::-webkit-scrollbar{width:9px;height:9px}
*::-webkit-scrollbar-thumb{background:var(--line);border-radius:5px}
*::-webkit-scrollbar-thumb:hover{background:var(--dim)}
.msg{transition:border-color .15s}
/* ---- beauty pass: atmosphere + depth, all keyed off the instance's own theme colours -------- */
/* Faint corner glows in the persona's primary/accent — vaporwave atmosphere without a fixed
   palette. color-mix keeps it whatever hue this instance themes to; unsupported browsers just
   see flat --bg. */
body::before{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;
  background:radial-gradient(115% 75% at 100% 0%,color-mix(in srgb,var(--p) 10%,transparent),transparent 55%),
    radial-gradient(90% 70% at 0% 100%,color-mix(in srgb,var(--a) 7%,transparent),transparent 52%)}
header b{text-shadow:0 0 18px color-mix(in srgb,var(--s) 35%,transparent)}
header .sp::before{content:'';display:inline-block;width:.42rem;height:.42rem;border-radius:50%;
  background:var(--s);margin-right:.42rem;vertical-align:.06rem;box-shadow:0 0 7px var(--s)}
nav button{transition:color .15s,border-color .15s}
nav button:hover{color:var(--fg)}
nav button[aria-selected=true]{text-shadow:0 0 12px color-mix(in srgb,var(--s) 45%,transparent)}
textarea:focus,input:focus{box-shadow:0 0 0 3px color-mix(in srgb,var(--p) 20%,transparent)}
button.go{background:linear-gradient(135deg,var(--p),color-mix(in srgb,var(--p) 55%,var(--a)));
  transition:filter .12s,transform .06s}
button.go:hover:not(:disabled){filter:brightness(1.09)}
button.go:active:not(:disabled){transform:translateY(1px)}
button.go.stopbtn{background:linear-gradient(135deg,#ff5f87,#c0395a)}
.her,.task,.mem,.ask{box-shadow:0 1px 3px rgba(0,0,0,.14)}
.task{transition:border-color .15s,transform .12s}
.task:hover{border-color:color-mix(in srgb,var(--p) 32%,var(--line))}
.badge.active{background:color-mix(in srgb,var(--s) 12%,var(--user))}
.badge.running{background:color-mix(in srgb,var(--p) 15%,var(--user))}
.badge.awaiting{background:color-mix(in srgb,var(--a) 15%,var(--user))}
.badge.failed{background:color-mix(in srgb,#ff5f87 14%,var(--user))}
.count{box-shadow:0 0 9px color-mix(in srgb,var(--a) 55%,transparent)}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
/* ---- phone ---------------------------------------------------------------- */
/* Reaching an instance from a phone is why this page exists, so the small screen is a first
   class layout, not a fallback. Two rules matter most and are easy to get wrong:
   (a) any input under 16px makes iOS Safari zoom the whole page on focus, and
   (b) a 27px button is not tappable -- touch guidance is ~44px. */
/* Driven by BOTH touch-capability and width: pointer:coarse catches a tablet at desktop width,
   and the width query still saves a phone whose pointer type reports wrong. */
@media(pointer:coarse),(max-width:560px){
  /* input[type=search] is listed explicitly: the base rule targets it by attribute and would
     otherwise out-specify this one, leaving the memory box at a zoom-triggering 15px. */
  textarea,input,select,input[type=search],.taskform input,.taskform textarea,.taskform select{font-size:16px}
  .task .acts button,button.mini,.sessrow button{min-height:2.6rem;padding-inline:.85rem}
  nav button{padding:.7rem .85rem}
  .thead{padding:.25rem 0}
  .body.md pre .copy{opacity:1}       /* no hover on touch — always show copy */
}
@media(max-width:560px){
  header{padding:.5rem .7rem;gap:.45rem}
  header .meta{font-size:.68rem;max-width:38vw}
  nav{padding:0 .25rem;scrollbar-width:none}
  nav::-webkit-scrollbar{display:none}
  /* Keep the tall touch target but tighten the sides so every tab fits a 390px screen instead
     of pushing the last one into a scroll nobody discovers. Measured, not guessed: at .55rem
     the seven tabs needed 404px and "settings" fell off the edge of a real phone. Vertical
     padding is untouched, so the ~44px touch height stands. */
  nav button{padding:.7rem .42rem;font-size:.8rem}
  #log{padding:.7rem;gap:.6rem}
  .msg{max-width:100%}
  .tasklist{padding:.5rem;gap:.45rem}
  .task .meta{gap:.5rem;font-size:.71rem}
  .task .acts{gap:.4rem}
  .taskform{margin:.4rem .5rem 0}
  .row,.sessrow{padding:.5rem}
  .pad{padding:.7rem}
  /* The composer is the one thing that must never be pushed off-screen by the keyboard. */
  form{padding:.5rem;gap:.4rem}
  button.go{padding:0 .9rem}
}
</style></head><body>
<header><b>egirl</b><span class="meta" id="hmeta">${esc(name)}</span><span class="sp" id="status">ready</span></header>
<nav id="tabs">
  <button data-tab="chat" aria-selected="true">chat</button>
  <button data-tab="tasks" aria-selected="false">tasks</button>
  <button data-tab="inbox" aria-selected="false">inbox<span class="count" id="inboxn" hidden>0</span></button>
  <button data-tab="peers" aria-selected="false">peers</button>
  <button data-tab="growth" aria-selected="false">growth</button>
  <button data-tab="memory" aria-selected="false">memory</button>
  <button data-tab="prompt" aria-selected="false">prompt</button>
  <button data-tab="info" aria-selected="false">settings</button>
</nav>
<main>
  <section class="tab" data-name="chat" data-on>
    <div class="sessrow"><select id="sess" title="session"></select><button id="snew" title="start a fresh conversation">+ new</button></div>
    <div id="log"></div>
    <div id="attach" class="attachrow" hidden></div>
    <form id="f"><button type="button" id="pick" class="clip" title="attach an image">+</button><input type="file" id="file" accept="image/*" multiple hidden><textarea id="m" rows="1" placeholder="Message ${esc(name)}…" autofocus></textarea><button class="go" id="b">Send</button></form>
  </section>

  <section class="tab" data-name="tasks">
    <div class="tbar"><button class="mini" id="newtask">+ new task</button></div>
    <div class="taskform" id="taskform" hidden>
      <input id="tf_name" placeholder="task name">
      <textarea id="tf_prompt" placeholder="what should she do each run? (the prompt)"></textarea>
      <div class="frow">
        <select id="tf_kind"><option value="oneshot">one-shot</option><option value="scheduled">scheduled</option></select>
        <input id="tf_interval" type="number" min="1" placeholder="every N min" hidden style="width:8rem">
        <label class="chk"><input type="checkbox" id="tf_unbounded"> unbounded</label>
        <button class="go" id="tf_create">Create</button>
      </div>
      <div class="dim" id="tf_err" hidden></div>
    </div>
    <div class="tasklist" id="tasks"><div class="empty">loading tasks…</div></div>
  </section>

  <section class="tab" data-name="inbox">
    <div class="tasklist" id="inbox"><div class="empty">loading…</div></div>
  </section>

  <section class="tab" data-name="peers">
    <div class="tasklist" id="peers"><div class="empty">loading…</div></div>
  </section>

  <section class="tab" data-name="growth">
    <div class="tasklist" id="growth"><div class="empty">loading…</div></div>
  </section>

  <section class="tab" data-name="memory">
    <div class="row"><input type="search" id="mq" placeholder="Search memories…"><button class="go" id="mgo">Search</button></div>
    <div class="pad" id="mres"><p style="color:var(--dim)">Search the agent's long-term memory. Results are ranked by relevance.</p></div>
  </section>

  <section class="tab" data-name="prompt">
    <div class="pad"><pre id="sysprompt">loading…</pre></div>
  </section>

  <section class="tab" data-name="info">
    <div class="pad">
      <div class="sect">
        <div class="dlabel">this conversation</div>
        <div class="ctxwrap">
          <div class="ctxbar"><span id="ctxfill"></span></div>
          <div class="ctxnums" id="ctxnums">context: loading…</div>
        </div>
        <div class="frow">
          <label class="chk" for="thinksel">thinking</label>
          <select id="thinksel">
            <option value="default">config default</option>
            <option value="off">off</option><option value="low">low</option>
            <option value="medium">medium</option><option value="high">high</option>
          </select>
          <button class="mini" id="compactbtn">compact now</button>
          <button class="mini danger" id="wipebtn">wipe session</button>
        </div>
        <div class="dim" id="sessmsg" hidden></div>
      </div>
      <div class="sect">
        <div class="dlabel">instance</div>
        <table id="infotbl"></table>
      </div>
      <div class="sect">
        <div class="dlabel">notifications</div>
        <div class="dim" id="pushstate">checking…</div>
        <div class="frow"><button class="mini" id="pushbtn" hidden>enable notifications</button>
          <button class="mini" id="pushtest" hidden>send a test</button></div>
      </div>
      ${
        hasToken
          ? `<div class="sect">
        <div class="dlabel">this browser</div>
        <div class="dim">The API token is stored in this browser so you are not asked on every
          visit. Forget it when you are on a device that is not yours, or to re-enter one you
          mistyped.</div>
        <div class="frow"><button class="mini danger" id="forgettok">forget saved token</button></div>
      </div>`
          : ''
      }
    </div>
  </section>
</main>
<script${nonce ? ` nonce="${esc(nonce)}"` : ''}>
const $=id=>document.getElementById(id);
const log=$('log'),f=$('f'),m=$('m'),b=$('b'),status=$('status'),sessSel=$('sess');
let sid=localStorage.getItem('egirl-sid')||('web:'+Math.random().toString(36).slice(2,10));
localStorage.setItem('egirl-sid',sid);
${hasToken ? `let tok=localStorage.getItem('egirl-token');if(!tok){tok=prompt('API token');if(tok)localStorage.setItem('egirl-token',tok)}` : 'const tok=null;'}
const H=()=>{const h={'Content-Type':'application/json'};if(tok)h['Authorization']='Bearer '+tok;return h};
// Quotes are escaped as well as angle brackets, and that is not optional: escaped values get
// interpolated into double-quoted attributes (href, data-*), so a surviving quote closes the
// attribute early and the rest of the value is parsed as more attributes -- an event handler,
// for instance. Browsers accept that with no whitespace at all. Everything rendered here can
// carry text the agent did not write: a page it fetched, a peer's message, a tool result. With
// the API token in localStorage and execute_command behind it, one injected handler is a shell.
const esc=t=>String(t??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Tabs are plain show/hide. Loaded lazily so opening the page does not fetch the system prompt
// and the whole memory store before anything has been typed.
const loaded={};
$('tabs').onclick=e=>{
  const t=e.target.dataset.tab; if(!t) return;
  for(const btn of $('tabs').children) btn.setAttribute('aria-selected', String(btn.dataset.tab===t));
  for(const s of document.querySelectorAll('.tab')) s.toggleAttribute('data-on', s.dataset.name===t);
  if(!loaded[t]){loaded[t]=1; if(t==='prompt')loadPrompt(); if(t==='info')loadInfo()}
  // Tasks/inbox are live views — refresh every time they're opened, not just once.
  if(t==='tasks')refreshTasks(true).catch(()=>{});
  if(t==='inbox')loadInbox().catch(()=>{});
  if(t==='peers')loadPeers();
  if(t==='growth')loadGrowth();
  // Context moves with every turn, so it is re-read each time settings is opened.
  if(t==='info'){loadContext();pushInit()}
};

function add(text,cls){const d=document.createElement('div');d.className='msg '+cls;d.textContent=text;
  log.appendChild(d);log.scrollTop=log.scrollHeight;return d}

// ---- Markdown -------------------------------------------------------------
// A small renderer so her code blocks, lists and headers read as what they are. No library: the
// whole console is one file, and full CommonMark is not worth the weight for a chat transcript.
// Content is HTML-escaped before any tag is inserted, so agent output can't inject markup. The
// backtick is built from a char code because a literal one would close this template string.
const BT=String.fromCharCode(96), FENCE=BT+BT+BT;
function mdInline(s){
  const code=new RegExp(BT+'([^'+BT+']+)'+BT,'g');
  return s
    .replace(code,'<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>')
    // italic runs after bold consumed its pairs; requiring a non-space, non-* char right after
    // the opening * keeps "a * b" math and "import *" from being swallowed.
    .replace(/\\*([^*\\s][^*]*?)\\*/g,'<em>$1</em>')
    // Second line of defence behind esc(): quotes and angle brackets are excluded from the URL
    // charset outright, so a link can never contribute attribute syntax even if escaping
    // regressed. http/https only -- javascript: and data: URLs are not links, they are payloads.
    .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s"'<>]+)\\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
function mdBlocks(text){
  const lines=esc(text).split('\\n'); let html='',list=null;
  const closeList=()=>{if(list){html+='</'+list+'>';list=null}};
  for(const line of lines){
    if(!line.trim()){closeList();continue}
    const mh=line.match(/^(#{1,3})\\s+(.*)$/);
    if(mh){closeList();const lv=mh[1].length+2;html+='<h'+lv+'>'+mdInline(mh[2])+'</h'+lv+'>';continue}
    if(/^(-{3,}|_{3,})$/.test(line.trim())){closeList();html+='<hr>';continue}
    const mq=line.match(/^&gt;\\s?(.*)$/);
    if(mq){closeList();html+='<blockquote>'+mdInline(mq[1])+'</blockquote>';continue}
    const mu=line.match(/^\\s*[-*]\\s+(.*)$/);
    if(mu){if(list!=='ul'){closeList();html+='<ul>';list='ul'}html+='<li>'+mdInline(mu[1])+'</li>';continue}
    const mo=line.match(/^\\s*\\d+\\.\\s+(.*)$/);
    if(mo){if(list!=='ol'){closeList();html+='<ol>';list='ol'}html+='<li>'+mdInline(mo[1])+'</li>';continue}
    closeList();html+='<div class="p">'+mdInline(line)+'</div>';
  }
  closeList(); return html;
}
function md(raw){
  // Split on the triple-backtick fence: odd segments are code (escaped, never inline-processed),
  // even segments are prose. An unclosed final fence still renders as a code block.
  const parts=String(raw||'').split(FENCE); let out='';
  for(let i=0;i<parts.length;i++){
    if(i%2===1){
      let seg=parts[i], lang='';
      const nl=seg.indexOf('\\n');
      if(nl>=0){const first=seg.slice(0,nl).trim(); if(/^[\\w+.-]*$/.test(first)){lang=first;seg=seg.slice(nl+1)}}
      out+='<pre'+(lang?' data-lang="'+esc(lang)+'"':'')+'><button class="copy">copy</button><code>'+esc(seg.replace(/\\n$/,''))+'</code></pre>';
    }else out+=mdBlocks(parts[i]);
  }
  return out;
}
function addMd(text){const d=add('','her');d.innerHTML='<div class="body md">'+md(text)+'</div>';return d}
// Copy buttons on code blocks (event-delegated so it covers streamed and historical messages).
log.addEventListener('click',e=>{
  const btn=e.target.closest('.copy'); if(!btn)return;
  const code=btn.parentElement.querySelector('code'); if(!code)return;
  navigator.clipboard.writeText(code.textContent).then(()=>{btn.textContent='copied';setTimeout(()=>{btn.textContent='copy'},1200)}).catch(()=>{btn.textContent='!'});
});

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
    // Where a conversation came from matters as much as its id: the same agent is reachable
    // from a phone over XMPP, a Discord DM, a peer agent and its own background tasks, and a
    // bare "task:b80effeb" in a dropdown says none of that.
    const MARK={web:'◇ web',cli:'▸ cli',xmpp:'✉ xmpp',discord:'✦ discord',task:'⚙ task',peer:'⇄ peer',api:'· api'};
    sessSel.innerHTML=list.map(x=>{
      const kind=String(x.id).split(':')[0];
      const label=(MARK[kind]||kind)+' · '+x.id+' · '+(x.message_count||0)+' msg'+
        (x.last_active_at?' · '+ago(x.last_active_at):'')+(x.busy?' · working…':'');
      return '<option value="'+esc(x.id)+'"'+(x.id===sid?' selected':'')+'>'+esc(label)+'</option>';
    }).join('');
  }catch(e){
    // The picker failing must not take the chat down with it, but the poller does need to hear
    // about it -- a swallowed error looks identical to a healthy server with nothing to report,
    // and would keep the retry rate pinned at full speed against a box that is gone.
    throw e;
  }
}

// History as the conversation looked, not as the model sees it: tool plumbing and injected
// [System:] notes are context, and a transcript full of them buries what was actually said.
function historyView(msgs){
  const out=[];
  for(const msg of msgs||[]){
    if(msg.role==='user'){
      if(msg.content.includes('<tool_response>'))continue;
      // A message from another agent arrives as a user turn wrapped in protocol boilerplate.
      // It is the only bracketed user message that is actually conversation -- everything else
      // ([System:], [Recalled...], [Conversation summary]) is machine plumbing. Hiding the lot
      // by prefix made every peer exchange look one-sided: you saw the replies and never the
      // questions. Strip the preamble and show what the peer actually said.
      // Backslashes doubled: this whole page is a template literal, which eats one level. The
      // single-escaped version compiles fine and ships a broken regex ([\\s\\S] arriving as
      // [sS]), which throws at runtime and renders the transcript empty.
      const peer=msg.content.match(/^\\[agent-to-agent\\] Message from peer "([^"]+)"[^\\n]*\\n+([\\s\\S]*)$/);
      if(peer){ out.push({who:'me',text:peer[2].trim(),from:peer[1]}); continue }
      if(msg.content.startsWith('['))continue;
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
    // 404 is expected for a fresh session id -- it just means nothing has been said yet.
    const r=await fetch('sessions/'+encodeURIComponent(sid),{headers:H()});
    if(r.ok){
      const d=await r.json();
      // The summary stands in for the OLDEST messages, so it sits above them, not below.
      if(d.has_summary)add('older messages are compacted into a summary','sys');
      for(const msg of historyView(d.messages)){
        if(msg.who==='her'){ addMd(msg.text); continue }
        const el=add(msg.text,msg.who);
        // Say who it came from when it was not you -- in a peer session both sides are agents.
        if(msg.from)el.dataset.from=msg.from;
      }
    }
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

// ---- Image attachments ----------------------------------------------------
// Downscaled client-side: a phone photo is 12MP of base64 nobody needs -- the vision encoder
// sees ~1k px. Longest edge 1280 keeps detail and keeps the request under control.
let pending_imgs=[];
async function addImage(fileOrBlob){
  if(pending_imgs.length>=4)return;
  const url=await new Promise(res=>{
    const img=new Image();
    img.onload=()=>{
      const scale=Math.min(1,1280/Math.max(img.width,img.height));
      const c=document.createElement('canvas');
      c.width=Math.round(img.width*scale);c.height=Math.round(img.height*scale);
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      res(c.toDataURL('image/jpeg',0.9));
    };
    img.src=URL.createObjectURL(fileOrBlob);
  });
  pending_imgs.push(url);renderAttach();
}
function renderAttach(){
  const a=$('attach');
  a.hidden=pending_imgs.length===0;
  a.innerHTML=pending_imgs.map((u,i)=>'<span class="thumb"><img src="'+u+'"><button type="button" class="x" data-i="'+i+'">×</button></span>').join('');
}
$('attach').onclick=e=>{const i=e.target.dataset.i;if(i!=null){pending_imgs.splice(Number(i),1);renderAttach()}};
$('pick').onclick=()=>$('file').click();
$('file').onchange=async()=>{for(const f of $('file').files)await addImage(f);$('file').value='';m.focus()};
// Paste an image straight into the message box, like any chat app.
m.addEventListener('paste',e=>{
  for(const item of e.clipboardData?.items??[]){
    if(item.type.startsWith('image/')){e.preventDefault();const f=item.getAsFile();if(f)addImage(f)}
  }
});
m.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();f.requestSubmit()}});

// ---- Sending --------------------------------------------------------------
// Send stays enabled while she works: the server queues per session, so typing ahead is the
// same contract as the CLI -- later messages wait their turn instead of interleaving. Each
// send keeps its own placeholder, so replies land in the bubbles that asked for them.
let inflight=0;
// While she works the Send button becomes Stop: clicking it aborts the running turn via the
// interrupt endpoint (the browser-side esc). Enter still queues a follow-up, same as the CLI.
function setStreaming(on){ b.textContent=on?'Stop':'Send'; b.classList.toggle('stopbtn',on); b.dataset.stop=on?'1':'' }
b.addEventListener('click',e=>{
  if(b.dataset.stop!=='1') return;
  e.preventDefault();
  fetch('sessions/'+encodeURIComponent(sid)+'/interrupt',{method:'POST',headers:H(),body:JSON.stringify({action:'abort'})}).catch(()=>{});
  status.textContent='stopping…';
});
// Once a turn finishes, fold its reasoning into a one-line toggle so the transcript stays about
// what she said, not how she got there — but it's one click away.
function collapseThink(el){
  const txt=el.textContent; el.textContent=''; el.classList.add('done');
  const head=document.createElement('div');head.className='thead';head.textContent='▸ thinking';
  const bd=document.createElement('div');bd.className='tbody';bd.textContent=txt;bd.hidden=true;
  head.onclick=()=>{bd.hidden=!bd.hidden;head.textContent=(bd.hidden?'▸':'▾')+' thinking'};
  el.append(head,bd);
}
f.onsubmit=async e=>{
  e.preventDefault();
  if(b.dataset.stop==='1') return; // the button is Stop right now — click handler owns it
  const text=m.value.trim(); if(!text&&pending_imgs.length===0) return;
  const imgs=pending_imgs; pending_imgs=[]; renderAttach();
  const mine=add(text||'(image)','me'); m.value=''; m.style.height='auto';
  for(const u of imgs){const im=document.createElement('img');im.src=u;mine.appendChild(im)}
  const wasBusy=inflight>0; inflight++;
  if(wasBusy)mine.classList.add('queued');
  setStreaming(true);
  status.textContent=wasBusy?'queued ('+inflight+')':'thinking…';
  const ph=add('','her pending');
  ph.innerHTML='<div class="think" hidden></div><div class="toolline" hidden></div><div class="body cursor">…</div>';
  const think=ph.querySelector('.think'),toolline=ph.querySelector('.toolline'),bodyEl=ph.querySelector('.body');
  const t0=Date.now(); let answer='',reasoning='',ntok=0,started=false;
  const startAnswer=()=>{if(!started){started=true;bodyEl.textContent='';mine.classList.remove('queued')}};
  try{
    const r=await fetch('chat',{method:'POST',headers:H(),body:JSON.stringify({message:text||'(see attached image)',session_id:sid,images:imgs.length?imgs:undefined,stream:true})});
    if(!r.ok||!r.body) throw new Error('HTTP '+r.status+(r.status===401?' — bad or missing token':''));
    const reader=r.body.getReader(),dec=new TextDecoder(); let buf='';
    for(;;){
      const {value,done}=await reader.read(); if(done)break;
      buf+=dec.decode(value,{stream:true});
      let i;
      while((i=buf.indexOf('\\n\\n'))>=0){
        const line=buf.slice(0,i).trim(); buf=buf.slice(i+2);
        if(!line.startsWith('data:'))continue;
        let ev; try{ev=JSON.parse(line.slice(5).trim())}catch(_){continue}
        if(ev.t==='queued'){status.textContent='queued ('+(ev.position+1)+')';}
        else if(ev.t==='reasoning'){reasoning+=ev.v;think.hidden=false;think.textContent=reasoning;think.scrollTop=think.scrollHeight;mine.classList.remove('queued');status.textContent='thinking… '+Math.round((Date.now()-t0)/1000)+'s';}
        else if(ev.t==='token'){startAnswer();answer+=ev.v;bodyEl.textContent=answer;log.scrollTop=log.scrollHeight;status.textContent='writing… '+(++ntok)+' tok';}
        else if(ev.t==='tool'){toolline.hidden=false;toolline.textContent='· '+(ev.v||[]).join(', ')+' …';status.textContent='running '+(ev.v||[]).join(', ');}
        else if(ev.t==='tool_done'){toolline.textContent='· '+ev.v+' ✓';}
        else if(ev.t==='error'){throw new Error(ev.message||'stream error');}
        else if(ev.t==='done'){
          answer=ev.content||answer||'(empty reply)';
          ph.className='msg her'; bodyEl.className='body md'; bodyEl.innerHTML=md(answer);
          if(reasoning)collapseThink(think); else think.hidden=true;
          toolline.hidden=true;
          status.textContent=Math.round((Date.now()-t0)/1000)+'s · '+(ev.output_tokens??ntok)+' tok · '+(ev.turns??'?')+' turns'+(ev.aborted?' · stopped':'')+(ev.awaiting?' · awaiting reply':'');
        }
      }
    }
    // Stream ended without a done frame (dropped connection): keep whatever streamed in.
    if(ph.classList.contains('pending')){ph.className='msg her';bodyEl.className='body md';bodyEl.innerHTML=md(answer||'(no output)');if(reasoning)collapseThink(think);}
  }catch(err){
    // Rendered in place: a local model can take minutes, and a swallowed error is
    // indistinguishable from one that is merely slow.
    ph.className='msg her fail'; ph.innerHTML=''; ph.textContent=String(err.message||err); status.textContent='failed';
  }finally{ inflight--; if(inflight<=0)setStreaming(false); m.focus() }
};

async function loadPrompt(){
  try{
    const r=await fetch('prompt?session_id='+encodeURIComponent(sid),{headers:H()});
    const d=await r.json();
    $('sysprompt').textContent=d.systemPrompt||'(empty)';
    $('sysprompt').insertAdjacentHTML('beforebegin','<p style="color:var(--dim);font-size:.8rem">'+d.length+' characters — IDENTITY, SOUL, AGENTS, USER and tool descriptions as the model receives them.</p>');
  }catch(e){ $('sysprompt').textContent='failed to load: '+e.message }
}

// ---- Notifications ---------------------------------------------------------
// The console is a pull surface: it shows everything, but only once you open it. Push is the
// half that reaches a phone that is not looking -- and notably it needs no inbound access to
// this instance at all, because the *server* connects outward to the browser's push service.
// The notification itself carries no content; tapping it opens the console, which fetches the
// real thing over this instance's own connection.
function b64urlToBytes(s){
  const pad='='.repeat((4-s.length%4)%4);
  const raw=atob((s+pad).replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
async function pushInit(){
  const state=$('pushstate'),btn=$('pushbtn'),test=$('pushtest');
  // iOS only exposes push to a page that has been added to the home screen, and only over a
  // secure context. Saying so plainly beats a button that silently does nothing.
  if(!('serviceWorker' in navigator)||!('PushManager' in window)){
    state.textContent=window.isSecureContext
      ? 'This browser does not support push notifications.'
      : 'Push needs a secure connection (https). Notifications are unavailable over plain http.';
    return;
  }
  let reg;
  try{ reg=await navigator.serviceWorker.register('sw.js',{scope:'./'}) }
  catch(e){ state.textContent='Could not register the service worker: '+(e.message||e); return }
  const existing=await reg.pushManager.getSubscription();
  if(existing){
    state.textContent='On — this device will be notified when something needs you.';
    btn.hidden=false; btn.textContent='turn off'; test.hidden=false;
    btn.onclick=async()=>{
      btn.disabled=true;
      try{
        await fetch('push/subscribe',{method:'DELETE',headers:H(),body:JSON.stringify({endpoint:existing.endpoint})});
        await existing.unsubscribe();
      }catch(e){}
      btn.disabled=false; pushInit();
    };
    test.onclick=async()=>{
      test.disabled=true; test.textContent='sending…';
      try{
        const d=await (await fetch('push/test',{method:'POST',headers:H()})).json();
        test.textContent=d.delivered?'sent to '+d.delivered+' device(s)':'no devices subscribed';
      }catch(e){ test.textContent='failed' }
      setTimeout(()=>{test.disabled=false;test.textContent='send a test'},2500);
    };
    return;
  }
  state.textContent='Off — nothing will reach you unless the console is open.';
  btn.hidden=false; btn.textContent='enable notifications'; test.hidden=true;
  btn.onclick=async()=>{
    btn.disabled=true;
    try{
      const perm=await Notification.requestPermission();
      if(perm!=='granted'){ state.textContent='Notifications were blocked in the browser.'; btn.disabled=false; return }
      const {public_key}=await (await fetch('push/key',{headers:H()})).json();
      const sub=await reg.pushManager.subscribe({
        userVisibleOnly:true,                       // required; every push shows a notification
        applicationServerKey:b64urlToBytes(public_key),
      });
      const j=sub.toJSON();
      await fetch('push/subscribe',{method:'POST',headers:H(),body:JSON.stringify({endpoint:j.endpoint,keys:j.keys})});
      pushInit();
    }catch(e){ state.textContent='Could not enable: '+(e.message||e) }
    finally{ btn.disabled=false }
  };
}

// ---- The saved token ------------------------------------------------------
// Kept in localStorage so a phone does not ask on every visit -- which also means it outlives
// the tab, so there has to be a way to hand the device back. And a mistyped token previously
// left the console 401ing forever with no way to correct it short of devtools.
function forgetToken(reason){
  try{
    localStorage.removeItem('egirl-token');
    // Carried across the reload instead of shown in a modal: a blocking dialog freezes every
    // other event on the page, and the reason is worth one line of status text, not a stop.
    if(reason)sessionStorage.setItem('egirl-authmsg',reason);
  }catch(e){}
  location.reload();
}
// Any 401 means the stored token is wrong or has been rotated: drop it and ask again, once.
let authPrompted=false;
function checkAuth(res){
  if(res&&res.status===401&&!authPrompted){
    authPrompted=true;
    forgetToken('token rejected — re-enter it');
  }
  return res;
}

// ---- Session settings -----------------------------------------------------
// The knobs the CLI has always had (/context, /think, /compact, /wipe), for everyone else. All
// scoped to the open conversation: turning thinking down to get a fast answer here should not
// quietly reconfigure Discord, XMPP and every background task too.
function say(msg,bad){const el=$('sessmsg');el.hidden=false;el.textContent=msg;
  el.className=bad?'warn':'dim';setTimeout(()=>{el.hidden=true},4000)}
async function loadContext(){
  try{
    const d=await (await fetch('sessions/'+encodeURIComponent(sid)+'/context',{headers:H()})).json();
    const pct=Math.round((d.utilization||0)*100);
    const fill=$('ctxfill');
    fill.style.width=Math.min(pct,100)+'%';
    fill.className=pct>80?'crit':pct>60?'warn2':'';
    const parts=[pct+'% of '+(d.context_length||0).toLocaleString()+' tokens',
      d.message_count+' messages (~'+(d.message_tokens||0).toLocaleString()+'t)',
      'system ~'+(d.system_prompt_tokens||0).toLocaleString()+'t'];
    if(d.has_summary)parts.push('summary ~'+(d.summary_tokens||0).toLocaleString()+'t');
    parts.push('~'+(d.available||0).toLocaleString()+'t free');
    $('ctxnums').textContent=parts.join('  ·  ');
    $('thinksel').value=d.thinking||'default';
  }catch(e){ $('ctxnums').textContent='context unavailable: '+(e.message||e) }
}
const _ft=$('forgettok');
if(_ft)_ft.onclick=()=>{
  // Two-click, like the other irreversible controls: losing the token means re-entering it.
  if(!_ft.dataset.armed){_ft.dataset.armed='1';_ft.textContent='really forget?';
    setTimeout(()=>{if(_ft.isConnected){delete _ft.dataset.armed;_ft.textContent='forget saved token'}},2600);return}
  forgetToken();
};
$('thinksel').onchange=async()=>{
  const level=$('thinksel').value;
  try{
    const r=await fetch('sessions/'+encodeURIComponent(sid)+'/thinking',{method:'POST',headers:H(),body:JSON.stringify({level})});
    if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||('HTTP '+r.status));
    say(level==='default'?'thinking follows the config default':'thinking set to '+level);
  }catch(e){ say(String(e.message||e),true) }
};
$('compactbtn').onclick=async()=>{
  const b=$('compactbtn');b.disabled=true;b.textContent='compacting…';
  try{
    const d=await (await fetch('sessions/'+encodeURIComponent(sid)+'/compact',{method:'POST',headers:H()})).json();
    say(d.dropped>0?d.dropped+' messages summarized, '+d.messages_after+' kept':'nothing to compact ('+d.messages_before+' messages)');
    loadContext();
  }catch(e){ say(String(e.message||e),true) }
  finally{ b.disabled=false;b.textContent='compact now' }
};
// Two-click, like the task delete: wiping a conversation is not undoable.
$('wipebtn').onclick=async()=>{
  const b=$('wipebtn');
  if(!b.dataset.armed){b.dataset.armed='1';b.textContent='really wipe?';
    setTimeout(()=>{if(b.isConnected){delete b.dataset.armed;b.textContent='wipe session'}},2600);return}
  delete b.dataset.armed;b.textContent='wipe session';
  try{
    await fetch('sessions/'+encodeURIComponent(sid),{method:'DELETE',headers:H()});
    say('session wiped');loadHistory();loadContext();
  }catch(e){ say(String(e.message||e),true) }
};

async function loadInfo(){
  try{
    // First call the page makes, so a bad token surfaces here rather than on the first message.
    const d=await (checkAuth(await fetch('info',{headers:H()}))).json();
    const rows=[
      ['name',d.name],['instance',d.instance],['persona',d.persona],['profile',d.profile],['theme',d.theme],
      ['model',d.model],['endpoint',d.endpoint],['context',d.contextLength?d.contextLength.toLocaleString()+' tokens':null],
      ['auxiliary',d.auxiliary?d.auxiliary.model+' @ '+d.auxiliary.endpoint:'none — compaction runs on the operator'],
      ['embeddings',d.embeddings?d.embeddings.model+' ('+d.embeddings.dimensions+'d)':'none — memory disabled'],
      ['memory',d.memory?'enabled':'disabled'],
      ['code agent',d.codeAgent||'off'],['thinking',d.thinking],
      ['reports to',d.report||null],
      ['permissions',d.permissions?d.permissions.mode+' · default '+d.permissions.defaultAction:null],
      ['workspace',d.workspace],
    ];
    $('infotbl').innerHTML=rows.filter(r=>r[1]!=null&&r[1]!=='')
      .map(r=>'<tr><td>'+esc(r[0])+'</td><td>'+esc(r[1])+'</td></tr>').join('');
    const tools=d.tools?Object.entries(d.tools).filter(([,v])=>v).map(([k])=>'<span class="chip">'+esc(k)+'</span>').join(''):'';
    if(tools) $('infotbl').insertAdjacentHTML('beforeend','<tr><td>tools</td><td>'+tools+'</td></tr>');
    // Identity moved here when the corner became the product name: a console that cannot tell
    // you which agent it is talking to is indistinguishable from any other instance's, and
    // getting that wrong means talking to the wrong agent without noticing. Name leads.
    $('hmeta').textContent=[d.name,d.model,d.instance!==d.name?d.instance:null].filter(Boolean).join(' · ');
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

// ---- Tasks: the mission-control view --------------------------------------
// The list is the same /tasks the CLI reads, plus a live running flag the stored status can't
// carry. Ordered by what wants attention: running and awaiting float up, done sinks. Polled so a
// run that starts elsewhere lights up here without a reload.
const RANK={running:0,awaiting:1,active:2,proposed:3,failed:4,paused:5,done:6};
let lastTasks=null, tasksOff=false;
function dur(ms){const s=Math.round(Math.abs(ms)/1000);
  if(s<60)return s+'s';if(s<3600)return Math.round(s/60)+'m';
  if(s<86400)return Math.round(s/3600)+'h';return Math.round(s/86400)+'d'}
function sched(t){
  if(t.running)return'running now';
  if(t.status==='awaiting')return'waiting on your reply';
  if(t.status==='paused')return'paused';
  if(t.status==='done')return'finished';
  if(t.next_run_at){const d=t.next_run_at-Date.now();return d>0?'next in '+dur(d):'due now'}
  if(t.cron)return'cron · '+t.cron;
  if(t.interval_ms)return'every '+dur(t.interval_ms);
  return t.kind||'oneshot';
}
function taskCard(t){
  const st=t.running?'running':t.status;
  const cls=t.running?'run':t.status==='awaiting'?'await':t.status==='failed'?'fail':'';
  const bits=[esc(sched(t)),(t.run_count||0)+(t.run_count===1?' run':' runs')];
  if(t.last_run_at&&!t.running)bits.push('last '+ago(t.last_run_at));
  if(t.consecutive_failures>0)bits.push('<span class="warn">'+t.consecutive_failures+'× failing</span>');
  const a=[],id=esc(t.id);
  if(t.running)a.push('<button class="stop" data-act="interrupt" data-id="'+id+'">◼ stop</button>');
  if(t.status==='paused')a.push('<button data-act="resume" data-id="'+id+'">▶ resume</button>');
  else if(t.status==='active'||t.status==='awaiting')a.push('<button data-act="pause" data-id="'+id+'">❚❚ pause</button>');
  if(!t.running)a.push('<button data-act="run" data-id="'+id+'">↻ run now</button>');
  a.push('<button class="danger" data-act="del" data-id="'+id+'">delete</button>');
  return '<div class="task '+cls+'" data-id="'+id+'">'+
    '<div class="top"><span class="badge '+st+'"><span class="dot"></span>'+st+'</span>'+
    '<span class="nm">'+esc(t.name)+'</span></div>'+
    '<div class="meta">'+bits.map(b=>'<span>'+b+'</span>').join('')+'</div>'+
    '<div class="acts">'+a.join('')+'</div></div>';
}
function updateInboxBadge(tasks){
  const n=tasks.filter(t=>t.status==='awaiting').length;
  const el=$('inboxn'); el.hidden=n===0; el.textContent=n;
}
function renderTasks(){
  if(document.querySelector('.tab[data-on]')?.dataset.name!=='tasks')return;
  const box=$('tasks');
  // Don't let the poll clobber a delete that's mid-confirm, or a task detail panel that's open
  // and being read, when it ticks under the user's cursor.
  if(box.querySelector('[data-armed],.task.open'))return;
  if(tasksOff){box.innerHTML='<div class="empty">Tasks are disabled on this instance.<br>Start the runner with <code>serve</code> to schedule work.</div>';return}
  if(!lastTasks)return;
  if(!lastTasks.length){box.innerHTML='<div class="empty">No tasks yet.<br>Background work scheduled here shows its status, and you can steer it live.</div>';return}
  const sorted=lastTasks.slice().sort((a,b)=>
    (RANK[a.running?'running':a.status]??8)-(RANK[b.running?'running':b.status]??8));
  box.innerHTML=sorted.map(taskCard).join('');
}
async function refreshTasks(showLoading){
  try{
    const r=await fetch('tasks',{headers:H()});
    if(r.status===503){tasksOff=true;renderTasks();return}
    lastTasks=(await r.json()).tasks||[]; tasksOff=false;
    updateInboxBadge(lastTasks); renderTasks();
  }catch(e){
    if(showLoading)$('tasks').innerHTML='<div class="empty">could not load tasks: '+esc(e.message||e)+'</div>';
    throw e;  // so the poller backs off instead of retrying a dead server every 5s
  }
}
// Expand/collapse a task's detail (prompt + recent runs) on a header-row click.
async function toggleDetail(card){
  if(!card)return;
  const id=card.dataset.id, open=card.querySelector('.detail');
  if(open){open.remove();card.classList.remove('open');return}
  card.classList.add('open');
  const det=document.createElement('div');det.className='detail';det.innerHTML='<div class="dim">loading…</div>';
  card.appendChild(det);
  try{
    const d=await (await fetch('tasks/'+encodeURIComponent(id)+'/history',{headers:H()})).json();
    det.innerHTML=renderDetail(d);
  }catch(e){det.innerHTML='<div class="dim">could not load: '+esc(e.message||e)+'</div>'}
}
function renderDetail(d){
  const t=d.task||{};
  const runs=(d.runs||[]).map(r=>{
    const when=r.started_at?ago(r.started_at):'';
    const dr=(r.completed_at&&r.started_at)?' · '+dur(r.completed_at-r.started_at):'';
    const tok=r.tokens_used?' · '+r.tokens_used+' tok':'';
    const raw=r.error?((r.error_kind?'['+r.error_kind+'] ':'')+r.error):(r.result||'(no output)');
    const body=(r.error?'<span class="warn">':'<span>')+esc(raw.slice(0,700))+(raw.length>700?'…':'')+'</span>';
    return '<div class="run"><div class="runhd"><span class="badge '+(r.status==='success'?'active':'failed')+'">'+
      '<span class="dot"></span>'+esc(r.status)+'</span>'+esc(when+dr+tok)+'</div>'+
      '<div class="runbody">'+body+'</div></div>';
  }).join('')||'<div class="dim">no runs recorded yet</div>';
  return '<div><div class="dlabel">prompt</div><pre class="pbody">'+esc(t.prompt||'(none)')+'</pre></div>'+
    '<div><div class="dlabel">recent runs</div>'+runs+'</div>';
}
$('tasks').onclick=async e=>{
  const btn=e.target.closest('button[data-act]');
  if(!btn){ const top=e.target.closest('.task .top'); if(top)toggleDetail(top.closest('.task')); return }
  const act=btn.dataset.act, id=btn.dataset.id;
  // Two-click delete: no native confirm() dialog, and irreversible needs a deliberate second tap.
  if(act==='del'&&!btn.dataset.armed){btn.dataset.armed='1';btn.textContent='really delete?';
    setTimeout(()=>{if(btn.isConnected){delete btn.dataset.armed;btn.textContent='delete'}},2600);return}
  btn.disabled=true;
  const tid=encodeURIComponent(id), sess=encodeURIComponent('task:'+id);
  try{
    if(act==='pause')await fetch('tasks/'+tid+'/pause',{method:'POST',headers:H()});
    else if(act==='resume')await fetch('tasks/'+tid+'/resume',{method:'POST',headers:H()});
    else if(act==='del')await fetch('tasks/'+tid,{method:'DELETE',headers:H()});
    else if(act==='interrupt')await fetch('sessions/'+sess+'/interrupt',{method:'POST',headers:H(),body:JSON.stringify({action:'abort'})});
    else if(act==='run'){
      // run-now blocks server-side for the whole run; fire it and let the poll show it go running
      // rather than freezing the button until it finishes.
      btn.textContent='starting…';
      fetch('tasks/'+tid+'/run',{method:'POST',headers:H()}).catch(()=>{}).then(()=>refreshTasks().catch(()=>{}));
      setTimeout(()=>refreshTasks().catch(()=>{}),500); return;
    }
  }catch(e){/* the refresh below reflects real state */}
  refreshTasks().catch(()=>{});
};

// ---- Create a task --------------------------------------------------------
$('newtask').onclick=()=>{const f=$('taskform');f.hidden=!f.hidden;if(!f.hidden)$('tf_name').focus()};
$('tf_kind').onchange=()=>{$('tf_interval').hidden=$('tf_kind').value!=='scheduled'};
$('tf_create').onclick=async()=>{
  const name=$('tf_name').value.trim(),prompt=$('tf_prompt').value.trim(),errEl=$('tf_err');
  errEl.hidden=true;
  if(!name||!prompt){errEl.textContent='name and prompt are required';errEl.hidden=false;return}
  const kind=$('tf_kind').value, body={name,prompt,kind,unbounded:$('tf_unbounded').checked};
  if(kind==='scheduled'){const mins=Number($('tf_interval').value);if(mins>0)body.interval_ms=mins*60000}
  $('tf_create').disabled=true;
  try{
    const r=await fetch('tasks',{method:'POST',headers:H(),body:JSON.stringify(body)});
    if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||('HTTP '+r.status))}
    $('tf_name').value='';$('tf_prompt').value='';$('tf_unbounded').checked=false;$('taskform').hidden=true;
    refreshTasks(true).catch(()=>{});
  }catch(e){errEl.textContent=String(e.message||e);errEl.hidden=false}
  finally{$('tf_create').disabled=false}
};

// ---- Peers: the other agents this one can reach ---------------------------
// Agent-to-agent traffic runs with no human in it, so without a view like this the only record
// that another agent exists is a config file. Shows where each peer came from (pinned by hand
// vs supplied by the Wald registry), whether it is answering right now, and what it calls
// itself — a name that disagrees with ours means the address points somewhere unexpected.
// Opening a peer's conversation jumps to the chat tab: their exchanges are ordinary sessions.
async function loadPeers(){
  const box=$('peers');
  let d;
  try{ d=await (await fetch('peers',{headers:H()})).json() }
  catch(e){ box.innerHTML='<div class="empty">could not load peers: '+esc(e.message||e)+'</div>'; return }
  const peers=d.peers||[];
  if(!peers.length){
    box.innerHTML='<div class="empty">No peers configured.<br>Add <code>[[peers]]</code> entries, or point this instance at a Wald registry to have them appear on their own.</div>';
    return;
  }
  box.innerHTML=peers.map(p=>{
    const up=p.reachable;
    const bits=[esc(p.url)];
    bits.push(p.discovered?'via registry':'pinned in config');
    if(!p.has_token)bits.push('<span class="warn">no token</span>');
    if(p.remote_name&&p.remote_name.toLowerCase()!==p.name.toLowerCase())
      bits.push('<span class="warn">answers to "'+esc(p.remote_name)+'"</span>');
    if(!up&&p.error)bits.push('<span class="warn">'+esc(String(p.error).slice(0,80))+'</span>');
    return '<div class="task '+(up?'':'fail')+'">'+
      '<div class="top"><span class="badge '+(up?'active':'failed')+'"><span class="dot"></span>'+
      (up?'up':'unreachable')+'</span><span class="nm">'+esc(p.name)+'</span></div>'+
      '<div class="meta">'+bits.map(b=>'<span>'+b+'</span>').join('')+'</div>'+
      '<div class="acts"><button data-peer="'+esc(p.name)+'">open conversation</button></div></div>';
  }).join('');
}
// ---- Growth (the self-improvement surface: skills, ledger, working memory) ----
async function loadGrowth(){
  const box=$('growth');
  let d;
  try{ d=await (await fetch('growth',{headers:H()})).json() }
  catch(e){ box.innerHTML='<div class="empty">could not load: '+esc(e.message||e)+'</div>'; return }
  const skills=d.skills||[], ledger=d.ledger||[], wm=d.working_memory||{};
  const pct=wm.budget?Math.round(100*wm.chars/wm.budget):0;
  let html='<div class="task"><div class="top"><span class="nm">working memory</span></div>'+
    '<div class="meta"><span>'+(wm.entries||0)+' entries</span><span>'+(wm.chars||0)+'/'+(wm.budget||0)+' chars ('+pct+'%)</span></div></div>';
  if(!skills.length){
    html+='<div class="empty">No skills yet. When the agent distills a procedure (or you run /learn), it appears here.</div>';
  }else{
    html+=skills.map(sk=>{
      const bits=[esc(sk.description||'(no description)')];
      if(sk.lint_errors)bits.push('<span class="warn">'+sk.lint_errors+' lint error(s)</span>');
      else if(sk.lint_warnings)bits.push('<span class="warn">'+sk.lint_warnings+' lint warning(s)</span>');
      return '<div class="task"><div class="top"><span class="badge '+(sk.origin==='agent'?'active':'')+'">'+
        esc(sk.origin)+'</span><span class="nm">'+esc(sk.name)+'</span></div>'+
        '<div class="meta">'+bits.map(b=>'<span>'+b+'</span>').join('')+'</div></div>';
    }).join('');
  }
  if(ledger.length){
    html+='<div class="task"><div class="top"><span class="nm">recent skill mutations</span></div><div class="meta">'+
      ledger.slice(0,12).map(en=>{
        const file=esc(String(en.path).split('/').slice(-2).join('/'));
        return '<span>'+esc(en.ts.slice(0,16).replace('T',' '))+' · '+esc(en.actor)+' '+esc(en.kind)+' '+file+'</span>';
      }).join('')+'</div></div>';
  }
  box.innerHTML=html;
}

// A peer conversation is just a session named peer:<name> — open it in the chat tab.
$('peers').onclick=e=>{
  const btn=e.target.closest('button[data-peer]'); if(!btn)return;
  const id='peer:'+btn.dataset.peer.toLowerCase().replace(/[^a-z0-9_-]/g,'_');
  if(![...sessSel.options].some(o=>o.value===id)){
    const o=document.createElement('option');o.value=id;o.textContent=id;sessSel.prepend(o);
  }
  sessSel.value=id; switchSession(id);
  document.querySelector('[data-tab="chat"]').click();
};

// ---- Inbox: answer what she's blocked on ----------------------------------
// An 'awaiting' task parked on an unanswered report(ask). The question is the last thing she
// said on the task's own session; replying there is exactly what resumes her (POST /chat flips
// the task active), so the inbox is a focused lens on the same plumbing chat already uses.
async function loadInbox(){
  const box=$('inbox');
  // Two kinds of thing wait on you: a task parked on an unanswered ask, and an agent that
  // decided something is your call and is blocked on the answer. Same question from your side.
  let asks=[];
  try{ asks=(await (await fetch('asks',{headers:H()})).json()).asks||[] }catch(e){}
  let tasks;
  try{
    const r=await fetch('tasks?status=awaiting',{headers:H()});
    if(r.status===503){box.innerHTML='<div class="empty">Tasks are disabled on this instance.</div>';return}
    tasks=(await r.json()).tasks||[];
  }catch(e){box.innerHTML='<div class="empty">could not load: '+esc(e.message||e)+'</div>';throw e}
  const askCards=asks.map(a=>{
    // A notice is a one-way report (task run results) — nothing awaits an answer.
    if(a.kind==='notice'){
      return '<div class="task await"><div class="top">'+
      '<span class="badge active"><span class="dot"></span>report</span>'+
      '<span class="nm">'+esc(a.from)+'</span></div>'+
      '<div class="meta"><span>'+esc(ago(a.asked_at))+'</span><span>one-way report</span></div>'+
      '<div class="q">'+esc(String(a.question).slice(0,1600))+'</div>'+
      '<div class="acts"><button data-dismiss="'+esc(a.id)+'">dismiss</button></div></div>';
    }
    return '<div class="task await ask"><div class="top">'+
    '<span class="badge awaiting"><span class="dot"></span>asking</span>'+
    '<span class="nm">'+esc(a.from)+'</span></div>'+
    '<div class="meta"><span>'+esc(ago(a.asked_at))+'</span><span>blocked until you answer</span></div>'+
    '<div class="q">'+esc(String(a.question).slice(0,1200))+'</div>'+
    '<div class="rep"><textarea rows="2" data-ask="'+esc(a.id)+'" placeholder="Your answer resumes them…"></textarea>'+
    '<button class="go" data-askreply="'+esc(a.id)+'">Send</button></div></div>';
  });
  if(!tasks.length&&!askCards.length){box.innerHTML='<div class="empty">Nothing waiting on you. 🌙<br>Blocked tasks and questions an agent escalated to you land here.</div>';return}
  if(!tasks.length){box.innerHTML=askCards.join('');return}
  const cards=await Promise.all(tasks.map(async t=>{
    let q='(open the conversation to see what she asked)';
    try{
      const s=await fetch('sessions/'+encodeURIComponent('task:'+t.id),{headers:H()});
      if(s.ok){const d=await s.json();
        const ask=[...(d.messages||[])].reverse().find(m=>
          m.role==='assistant'&&m.content&&!m.content.includes('<tool_call>')&&m.content.trim());
        if(ask)q=ask.content.replace(/<tool_call>[\\s\\S]*/,'').trim();
      }
    }catch(e){}
    return '<div class="task await ask"><div class="top">'+
      '<span class="badge awaiting"><span class="dot"></span>awaiting</span>'+
      '<span class="nm">'+esc(t.name)+'</span></div>'+
      '<div class="q">'+esc(q.slice(0,900))+'</div>'+
      '<div class="rep"><textarea rows="2" data-id="'+esc(t.id)+'" placeholder="Reply to resume her…"></textarea>'+
      '<button class="go" data-reply="'+esc(t.id)+'">Send</button></div></div>';
  }));
  box.innerHTML=askCards.concat(cards).join('');
}
$('inbox').onclick=async e=>{
  const db=e.target.closest('button[data-dismiss]');
  if(db){
    db.disabled=true;
    try{ await fetch('asks/'+encodeURIComponent(db.dataset.dismiss)+'/dismiss',{method:'POST',headers:H()}) }catch(err){}
    loadInbox();
    return;
  }
  const ab=e.target.closest('button[data-askreply]');
  if(ab){
    const id=ab.dataset.askreply;
    const ta=$('inbox').querySelector('textarea[data-ask="'+CSS.escape(id)+'"]');
    const text=(ta?.value||'').trim(); if(!text)return;
    ab.disabled=true; ab.textContent='sending…';
    try{
      const d=await (await fetch('asks/'+encodeURIComponent(id)+'/reply',{method:'POST',headers:H(),body:JSON.stringify({reply:text})})).json();
      // delivered=false means they stopped waiting before the answer arrived — worth saying,
      // because the agent will not act on it and you would otherwise assume it landed.
      if(!d.delivered)say('Answer recorded, but they had already stopped waiting.',true);
    }catch(err){ ab.disabled=false; ab.textContent='Send'; return }
    loadInbox();
    return;
  }
  const btn=e.target.closest('button[data-reply]'); if(!btn)return;
  const id=btn.dataset.reply;
  const ta=$('inbox').querySelector('textarea[data-id="'+CSS.escape(id)+'"]');
  const text=(ta?.value||'').trim(); if(!text)return;
  btn.disabled=true; btn.textContent='sending…';
  try{ await fetch('chat',{method:'POST',headers:H(),body:JSON.stringify({message:text,session_id:'task:'+id})}) }
  catch(e){ btn.disabled=false; btn.textContent='Send'; return }
  loadInbox().catch(()=>{}); refreshTasks().catch(()=>{});
};

// ---- Polling ---------------------------------------------------------------
// setInterval is the wrong primitive for this. It fires whether or not the previous request came
// back, whether or not the server is still up, and whether or not anyone is looking -- a phone
// with this open in a background tab would poll all night on the mobile radio to update a screen
// nobody can see. This loop instead:
//   - skips while the tab is hidden, and refreshes immediately when you come back
//   - never overlaps requests: the next delay starts when the last one settles
//   - doubles the delay on failure up to a cap, resetting the moment a request succeeds
// so an instance that goes down gets retried occasionally instead of hammered forever.
function poller(fn,baseMs,maxMs){
  let delay=baseMs,timer=null,inflight=false;
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(tick,delay)};
  async function tick(){
    if(document.hidden||inflight){schedule();return}
    inflight=true;
    try{ await fn(); delay=baseMs; setOnline(true) }
    catch(e){ delay=Math.min(delay*2,maxMs); setOnline(false) }
    finally{ inflight=false; schedule() }
  }
  document.addEventListener('visibilitychange',()=>{
    // Returning to the tab should show current data, not whatever was true when you left.
    if(!document.hidden){delay=baseMs;clearTimeout(timer);tick()}
  });
  schedule();
}
// A console quietly showing stale numbers is worse than one that admits it lost the server.
let online=true;
function setOnline(ok){
  if(ok===online)return; online=ok;
  if(!ok)status.textContent='disconnected — retrying';
  else if(status.textContent==='disconnected — retrying')status.textContent='ready';
}

// Identity is fetched immediately even though its tab is lazy: the header should say what you
// are talking to before you say anything to it.
try{
  const _am=sessionStorage.getItem('egirl-authmsg');
  if(_am){sessionStorage.removeItem('egirl-authmsg');status.textContent=_am}
}catch(e){}
loadInfo(); loaded.info=1;
// The conversation you were having is the first thing the page should show, not an empty box.
loadSessions().catch(()=>{}); loadHistory();
// Prime the inbox badge on load so an unanswered ask is visible from the chat tab, before the
// tasks/inbox tabs are ever opened.
refreshTasks().catch(()=>{});
// Sessions started elsewhere (the CLI, a peer) appear without a reload. 30s is fresh enough for
// a picker; backs off to 5min if the instance goes away.
poller(loadSessions,30000,300000);
// Tasks: 5s keeps a running badge honest. Only the visible tab re-renders, but the fetch also
// keeps the inbox count current from any tab. Backs off to a minute when the server is down.
poller(async()=>{
  const on=document.querySelector('.tab[data-on]')?.dataset.name;
  await refreshTasks();
  if(on==='inbox')await loadInbox();
},5000,60000);
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
export function ansiToHex(ansi: string): string {
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
