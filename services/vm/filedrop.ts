#!/usr/bin/env bun
/**
 * Drop files into a sandboxed VM's share directory from a browser.
 *
 * Runs on the *host*, writing into the directory the guest mounts read-mostly. That direction is
 * deliberate: the alternative -- an upload endpoint inside the VM -- means exposing the sandbox's
 * own HTTP surface to the network, which is the opposite of why the sandbox exists.
 *
 * Binds to localhost by default. A file drop for an agent that runs untrusted code is not
 * something to put on a LAN by accident, so widening it is an explicit flag plus a token.
 *
 *   bun services/vm/filedrop.ts --dir ~/.egirl/vms/zero/share
 *   bun services/vm/filedrop.ts --dir ~/.egirl/vms/zero/share --host 0.0.0.0 --token $(openssl rand -hex 16)
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { safeName, uniqueName } from './safe-name'

interface Options {
  dir: string
  host: string
  port: number
  token?: string
  maxBytes: number
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dir: '',
    host: '127.0.0.1',
    port: 3100,
    maxBytes: 2 * 1024 * 1024 * 1024,
  }

  for (let i = 0; i < argv.length; i++) {
    const next = (): string => {
      const value = argv[++i]
      if (!value) throw new Error(`${argv[i - 1]} requires a value`)
      return value
    }
    switch (argv[i]) {
      case '--dir':
        options.dir = resolve(next().replace(/^~/, process.env.HOME ?? '~'))
        break
      case '--host':
        options.host = next()
        break
      case '--port':
        options.port = Number(next())
        break
      case '--token':
        options.token = next()
        break
      case '--max-mb':
        options.maxBytes = Number(next()) * 1024 * 1024
        break
      default:
        throw new Error(`unknown option: ${argv[i]}`)
    }
  }

  if (!options.dir) throw new Error('--dir is required (the VM share directory)')
  if (options.host !== '127.0.0.1' && !options.token) {
    // Binding wide without a token would publish a write-anything endpoint to the network.
    throw new Error('--token is required when --host is not 127.0.0.1')
  }
  return options
}

function listFiles(dir: string): Array<{ name: string; size: number; mtime: number }> {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => {
      try {
        const s = statSync(join(dir, name))
        return s.isFile() ? { name, size: s.size, mtime: s.mtimeMs } : undefined
      } catch {
        return undefined
      }
    })
    .filter((f): f is { name: string; size: number; mtime: number } => f !== undefined)
    .sort((a, b) => b.mtime - a.mtime)
}

function page(dir: string): string {
  const rows = listFiles(dir)
    .map(
      (f) =>
        `<li><span>${escapeHtml(f.name)}</span><em>${(f.size / 1024).toFixed(0)} KB</em></li>`,
    )
    .join('')

  return `<!doctype html><meta charset="utf-8"><title>file drop</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark light}
body{font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:44rem;margin:3rem auto;padding:0 1.2rem;background:#0e0f13;color:#d7dae0}
h1{font-size:1rem;letter-spacing:.12em;text-transform:uppercase;color:#5ee6c4;margin:0 0 .3rem}
p.path{color:#6b7180;margin:0 0 1.6rem;word-break:break-all}
#drop{border:1px dashed #2f3542;border-radius:6px;padding:2.6rem 1rem;text-align:center;color:#8b92a2;cursor:pointer;transition:border-color .15s,color .15s}
#drop.over{border-color:#5ee6c4;color:#5ee6c4}
ul{list-style:none;padding:0;margin:1.6rem 0 0}
li{display:flex;justify-content:space-between;gap:1rem;padding:.4rem 0;border-bottom:1px solid #1c1f27}
li em{font-style:normal;color:#6b7180;white-space:nowrap}
#log{margin-top:1rem;color:#6b7180;min-height:1.4em}
@media(prefers-color-scheme:light){body{background:#fbfbfd;color:#23262d}li{border-color:#e6e8ec}#drop{border-color:#d3d7de}}
</style>
<h1>file drop</h1><p class="path">${escapeHtml(dir)}</p>
<div id="drop">drop files here, or click to choose</div>
<input id="pick" type="file" multiple hidden>
<div id="log"></div>
<ul id="files">${rows}</ul>
<script>
const drop=document.getElementById('drop'),pick=document.getElementById('pick'),log=document.getElementById('log')
drop.onclick=()=>pick.click()
drop.ondragover=e=>{e.preventDefault();drop.classList.add('over')}
drop.ondragleave=()=>drop.classList.remove('over')
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('over');send(e.dataTransfer.files)}
pick.onchange=()=>send(pick.files)
async function send(files){
  for(const f of files){
    log.textContent='uploading '+f.name+'…'
    const body=new FormData();body.append('file',f)
    const r=await fetch('upload',{method:'POST',body})
    log.textContent=r.ok?(await r.text()):'failed: '+(await r.text())
  }
  location.reload()
}
</script>`
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  mkdirSync(options.dir, { recursive: true })

  Bun.serve({
    hostname: options.host,
    port: options.port,
    maxRequestBodySize: options.maxBytes,
    async fetch(req) {
      const url = new URL(req.url)

      if (options.token) {
        const supplied = url.searchParams.get('token') ?? req.headers.get('x-token')
        if (supplied !== options.token) return new Response('unauthorised', { status: 401 })
      }

      if (req.method === 'GET' && url.pathname === '/') {
        return new Response(page(options.dir), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }

      if (req.method === 'POST' && url.pathname === '/upload') {
        const form = await req.formData()
        const file = form.get('file')
        if (!(file instanceof File)) return new Response('no file', { status: 400 })

        const name = safeName(file.name)
        // A name that sanitises to nothing is refused rather than given a generated one: a
        // substituted name is an upload the user believes landed somewhere it did not.
        if (!name) return new Response('unusable filename', { status: 400 })

        const final = uniqueName(name, (candidate) => existsSync(join(options.dir, candidate)))
        await Bun.write(join(options.dir, final), file)
        return new Response(`saved ${final}`)
      }

      return new Response('not found', { status: 404 })
    },
  })

  console.log(`file drop  http://${options.host}:${options.port}${options.token ? '?token=…' : ''}`)
  console.log(`writing to ${options.dir}`)
}

main()
