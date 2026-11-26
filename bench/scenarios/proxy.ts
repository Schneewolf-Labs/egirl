#!/usr/bin/env bun
/**
 * Recording proxy for an OpenAI-compatible endpoint.
 *
 * Every POST /v1/chat/completions body is appended to a JSONL file before anything else
 * happens, so a scenario can assert on exactly what egirl sent to the model. Embedding
 * requests are recorded to the same file (kind "embeddings"), which tells a check whether a
 * turn's text was even searched for.
 *
 *   upstream mode: the request is forwarded byte-for-byte and the response streamed back as-is.
 *   stub mode:     answered locally with a fixed short reply (SSE or JSON, as asked), and the
 *                  llama.cpp side endpoints egirl probes (/props, /tokenize, /slots) answer 404,
 *                  which egirl treats as "not a llama-server" and degrades from.
 *
 * Embeddings are served by the stub embedder unless an embeddings upstream is given; see
 * stubEmbedding for why it is shaped the way it is.
 *
 * Standalone: bun bench/scenarios/proxy.ts --log /tmp/req.jsonl [--upstream URL] [--port N]
 */

import { appendFileSync } from 'node:fs'

export interface ProxyOptions {
  /** JSONL file every recorded request is appended to */
  logPath: string
  /** Forward chat requests here; absent means stub mode */
  upstream?: string
  /** Forward embedding requests here; absent means the stub embedder */
  embeddingsUpstream?: string
  /** Dimensions of stub embeddings */
  embedDims?: number
  /** 0 = pick a free port */
  port?: number
  /** The fixed assistant reply in stub mode */
  stubReply?: string
}

export interface RecordedRequest {
  seq: number
  at: number
  kind: 'chat' | 'embeddings'
  body: unknown
}

export interface RecordingProxy {
  url: string
  port: number
  /** Number of requests recorded so far; a turn's requests are the ones between two reads */
  count(): number
  /**
   * Resolve once no recorded request is in flight and none has started or finished for
   * `quietMs`. Post-run work (memory extraction, lesson extraction, the embedding calls their
   * writes make) is fire-and-forget in egirl, so a check that reads the DB the moment the run's
   * HTTP call returns would race it. Resolves false if `maxMs` passes first.
   */
  settle(quietMs?: number, maxMs?: number): Promise<boolean>
  stop(): void
}

export const STUB_REPLY = 'ok.'
export const STUB_EMBED_DIMS = 256

/**
 * Cosine similarity the stub embedder gives two texts with no word in common.
 *
 * A real embedding model is anisotropic: unrelated English sentences still land at a cosine
 * well above zero (Qwen3-class models put most pairs somewhere around 0.2-0.4). That floor is
 * what makes proactive recall fire on "hey juno" in production, so a stub that gave unrelated
 * text a cosine of 0 would hide the very behaviour scenarios exist to catch. Each vector is a
 * hashed bag of words plus one shared component sized so disjoint texts meet at this value.
 */
export const STUB_EMBED_BASELINE = 0.3

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((w) =>
    w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w,
  )
}

function hash(word: string): number {
  let h = 2166136261
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Deterministic, unit-length; see STUB_EMBED_BASELINE. */
export function stubEmbedding(text: string, dims = STUB_EMBED_DIMS): number[] {
  const bag = new Array<number>(dims).fill(0)
  for (const w of words(text)) {
    const h = hash(w)
    // Slot 0 is the shared component; words hash into the rest.
    const slot = 1 + (h % (dims - 1))
    bag[slot] = (bag[slot] ?? 0) + ((h >>> 31) & 1 ? 1 : -1)
  }
  const bagNorm = Math.sqrt(bag.reduce((s, v) => s + v * v, 0))
  // With the bag at unit length and the shared component c, disjoint texts meet at
  // c² / (1 + c²); solve that for the baseline.
  const c = Math.sqrt(STUB_EMBED_BASELINE / (1 - STUB_EMBED_BASELINE))
  const v = bag.map((x) => (bagNorm > 0 ? x / bagNorm : 0))
  v[0] = c
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map((x) => x / norm)
}

function stubChat(body: Record<string, unknown>, reply: string): Response {
  const id = `chatcmpl-stub-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const model = typeof body.model === 'string' ? body.model : 'stub'
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  if (body.stream !== true) {
    return Response.json({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
      ],
      usage,
    })
  }
  const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`
  const base = { id, object: 'chat.completion.chunk', created, model }
  const sse =
    chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply } }] }) +
    chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
    chunk({ ...base, choices: [], usage }) +
    'data: [DONE]\n\n'
  return new Response(sse, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}

function stubEmbeddings(body: Record<string, unknown>, dims: number): Response {
  const raw = body.input ?? body.content ?? ''
  const inputs = Array.isArray(raw) ? raw : [raw]
  return Response.json({
    object: 'list',
    data: inputs.map((t, index) => ({
      object: 'embedding',
      index,
      embedding: stubEmbedding(String(t), dims),
    })),
    model: 'stub-embed',
    usage: { prompt_tokens: 0, total_tokens: 0 },
  })
}

async function forward(req: Request, base: string, body?: string): Promise<Response> {
  const url = new URL(req.url)
  const headers = new Headers(req.headers)
  headers.delete('host')
  headers.delete('content-length')
  const res = await fetch(`${base.replace(/\/+$/, '')}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    ...(body !== undefined && { body }),
  })
  // Hand the body stream straight back so SSE arrives chunk by chunk, as it left upstream.
  const out = new Headers(res.headers)
  out.delete('content-encoding')
  out.delete('content-length')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}

export function startProxy(opts: ProxyOptions): RecordingProxy {
  let seq = 0
  let inflight = 0
  let lastActivity = Date.now()

  /** Counts a recorded request until its response body has been fully sent (or abandoned). */
  const tracked = async (pending: Response | Promise<Response>): Promise<Response> => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      inflight--
      lastActivity = Date.now()
    }
    let res: Response
    try {
      res = await pending
    } catch (e) {
      finish()
      throw e
    }
    if (!res.body) {
      finish()
      return res
    }
    const pass = new TransformStream({ flush: finish })
    res.body.pipeTo(pass.writable).catch(finish)
    return new Response(pass.readable, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
  const dims = opts.embedDims ?? STUB_EMBED_DIMS
  const reply = opts.stubReply ?? STUB_REPLY

  const record = (kind: RecordedRequest['kind'], text: string): Record<string, unknown> => {
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(text) as Record<string, unknown>
    } catch {
      body = { unparsed: text }
    }
    const entry: RecordedRequest = { seq: seq++, at: Date.now(), kind, body }
    appendFileSync(opts.logPath, `${JSON.stringify(entry)}\n`)
    inflight++
    lastActivity = Date.now()
    return body
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    // A slow upstream turn can sit in prefill for minutes before its first byte.
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const text = await req.text()
        const body = record('chat', text)
        return tracked(opts.upstream ? forward(req, opts.upstream, text) : stubChat(body, reply))
      }
      if (req.method === 'POST' && (path === '/v1/embeddings' || path === '/embeddings')) {
        const text = await req.text()
        const body = record('embeddings', text)
        return tracked(
          opts.embeddingsUpstream
            ? forward(req, opts.embeddingsUpstream, text)
            : stubEmbeddings(body, dims),
        )
      }
      if (opts.upstream) {
        const text = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text()
        return forward(req, opts.upstream, text)
      }
      if (req.method === 'GET' && path === '/v1/models') {
        return Response.json({
          object: 'list',
          data: [{ id: 'stub', object: 'model', owned_by: 'scenario-proxy' }],
        })
      }
      if (path === '/health') return Response.json({ status: 'ok' })
      // /props, /tokenize, /slots, /apply-template: egirl reads a 404 as "not llama.cpp" and
      // falls back to estimates, which is all a stub needs.
      return new Response('not found', { status: 404 })
    },
  })

  const port = server.port ?? 0
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    count: () => seq,
    settle: async (quietMs = 3000, maxMs = 600_000) => {
      const deadline = Date.now() + maxMs
      while (Date.now() < deadline) {
        if (inflight === 0 && Date.now() - lastActivity >= quietMs) return true
        await Bun.sleep(100)
      }
      return false
    },
    stop: () => server.stop(true),
  }
}

if (import.meta.main) {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`)
    return i !== -1 ? process.argv[i + 1] : undefined
  }
  const logPath = arg('log')
  if (!logPath) {
    console.error(
      'usage: bun bench/scenarios/proxy.ts --log <file.jsonl> [--upstream URL] [--port N]',
    )
    process.exit(2)
  }
  const upstream = arg('upstream')
  const embeddingsUpstream = arg('embeddings')
  const p = startProxy({
    logPath,
    port: Number(arg('port') ?? 0),
    ...(upstream && { upstream }),
    ...(embeddingsUpstream && { embeddingsUpstream }),
  })
  console.error(
    `proxy ${upstream ? `-> ${upstream}` : '(stub)'} on ${p.url}, logging to ${logPath}`,
  )
}
