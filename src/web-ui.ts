/**
 * A chat page for the HTTP API.
 *
 * The API already exposes everything a conversation needs; what it lacked was somewhere to type.
 * Reaching an instance meant ssh and a terminal, or hand-rolled curl -- fine at a desk, useless
 * from a phone, and the reason a whole XMPP server got stood up before anyone noticed the simpler
 * option was three lines of fetch().
 *
 * Deliberately one self-contained string rather than a build step, a framework, or a second
 * service. It is served by the API process that already exists, on the port already configured
 * per instance, behind the token already supported. Nothing new to run, nothing new to secure.
 */

import type { Theme } from './ui/theme'

/**
 * The page, with the instance's own palette baked in.
 *
 * Colours come from the same theme the CLI uses, so an instance looks like itself in a browser
 * -- which matters more than it sounds when several are running and they are distinguished only
 * by what they say.
 */
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
:root{--p:${p};--s:${s};--a:${a};--bg:#0d0e12;--fg:#e6e8ee;--dim:#8b90a0;--line:#1e2028;--user:#171a22}
@media(prefers-color-scheme:light){:root{--bg:#fcfcfe;--fg:#1a1c22;--dim:#6b7080;--line:#e4e6ec;--user:#f0f1f5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
     display:flex;flex-direction:column;height:100dvh}
header{padding:.7rem 1rem;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:.6rem;flex:none}
header b{color:var(--s);font-size:.95rem;letter-spacing:.02em}
header span{color:var(--dim);font-size:.75rem;margin-left:auto}
#log{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.85rem;-webkit-overflow-scrolling:touch}
.msg{max-width:min(46rem,92%);padding:.6rem .85rem;border-radius:.7rem;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}
.me{align-self:flex-end;background:var(--user)}
.her{align-self:flex-start;border:1px solid var(--line);border-left:2px solid var(--p)}
.her code,.me code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;background:#0000001a;padding:.1em .3em;border-radius:.25em}
.pending{color:var(--dim);font-style:italic}
.fail{border-left-color:#ff5f87;color:#ff9db4}
form{display:flex;gap:.5rem;padding:.7rem;border-top:1px solid var(--line);flex:none;
     padding-bottom:calc(.7rem + env(safe-area-inset-bottom))}
textarea{flex:1;resize:none;background:var(--user);color:var(--fg);border:1px solid var(--line);
         border-radius:.6rem;padding:.55rem .7rem;font:inherit;max-height:9rem}
textarea:focus{outline:none;border-color:var(--p)}
button{background:var(--p);color:#fff;border:0;border-radius:.6rem;padding:0 1.05rem;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.45;cursor:default}
</style></head><body>
<header><b>${esc(name)}</b><span id="status">ready</span></header>
<div id="log"></div>
<form id="f"><textarea id="m" rows="1" placeholder="Message ${esc(name)}…" autofocus></textarea><button id="b">Send</button></form>
<script>
const log=document.getElementById('log'),f=document.getElementById('f'),m=document.getElementById('m'),
      b=document.getElementById('b'),status=document.getElementById('status');
// Session id is per browser, so reloading the page continues the conversation rather than
// silently starting a new one the agent has no memory of.
const sid=localStorage.getItem('egirl-sid')||('web:'+Math.random().toString(36).slice(2,10));
localStorage.setItem('egirl-sid',sid);
${hasToken ? `const tok=localStorage.getItem('egirl-token')||prompt('API token');if(tok)localStorage.setItem('egirl-token',tok);` : 'const tok=null;'}

function add(text,cls){const d=document.createElement('div');d.className='msg '+cls;d.textContent=text;
  log.appendChild(d);log.scrollTop=log.scrollHeight;return d}

m.addEventListener('input',()=>{m.style.height='auto';m.style.height=Math.min(m.scrollHeight,144)+'px'});
m.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();f.requestSubmit()}});

f.onsubmit=async e=>{
  e.preventDefault();
  const text=m.value.trim(); if(!text) return;
  add(text,'me'); m.value=''; m.style.height='auto';
  b.disabled=true; status.textContent='thinking…';
  const ph=add('…','her pending');
  const started=Date.now();
  try{
    const h={'Content-Type':'application/json'}; if(tok) h['Authorization']='Bearer '+tok;
    const r=await fetch('chat',{method:'POST',headers:h,body:JSON.stringify({message:text,session_id:sid})});
    if(!r.ok) throw new Error('HTTP '+r.status+(r.status===401?' — bad or missing token':''));
    const d=await r.json();
    ph.className='msg her'; ph.textContent=d.content||'(empty reply)';
    status.textContent=Math.round((Date.now()-started)/1000)+'s · '+(d.output_tokens??'?')+' tok';
  }catch(err){
    // Shown in place rather than swallowed: a local model behind this can take a long time, and
    // a silent failure is indistinguishable from one that is merely slow.
    ph.className='msg her fail'; ph.textContent=String(err.message||err);
    status.textContent='failed';
  }finally{ b.disabled=false; m.focus() }
};
</script></body></html>`
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

/**
 * The CLI palette is 256-colour ANSI; a browser needs hex. Mapped through the standard xterm
 * cube so an instance's colours are the same ones its terminal shows, not an approximation
 * chosen by eye.
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
