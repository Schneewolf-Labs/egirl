import type { AgentFactory, AgentLoop } from './agent'
import type { MemoryCategory, MemoryManager } from './memory'
import { formatInboundPeerMessage, PEER_PROTOCOL, peerSessionId } from './peers/protocol'
import type { Task, TaskRunner, TaskStore } from './tasks'
import { getTheme } from './ui/theme'
import { log } from './util/logger'
import { renderChatPage } from './web-ui'

export interface APIConfig {
  host: string
  port: number
  /** If set, requests must include `Authorization: Bearer <token>` */
  bearerToken?: string
}

export interface APIDeps {
  /** Build an agent for a given session ID. Sessions are persisted if conversations is enabled. */
  agentFactory: AgentFactory
  /** In-process cache of per-session agents so each POST /chat reuses the same context. */
  agents: Map<string, AgentLoop>
  memory?: MemoryManager
  taskStore?: TaskStore
  taskRunner?: TaskRunner
  /** why the runner is absent, so a 503 can name the flag instead of just saying "disabled" */
  taskOffReason?: string
  /** Identity announced to peer agents on /peer/identity and in /peer/message replies. */
  selfName?: string
}

type JSONValue = string | number | boolean | null | JSONValue[] | { [k: string]: JSONValue }

function json(body: JSONValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status)
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

function getOrCreateAgent(sessionId: string, deps: APIDeps): AgentLoop {
  let agent = deps.agents.get(sessionId)
  if (!agent) {
    agent = deps.agentFactory(sessionId)
    deps.agents.set(sessionId, agent)
  }
  return agent
}

function taskToJson(t: Task): JSONValue {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    kind: t.kind,
    status: t.status,
    prompt: t.prompt,
    interval_ms: t.intervalMs ?? null,
    cron: t.cronExpression ?? null,
    next_run_at: t.nextRunAt ?? null,
    last_run_at: t.lastRunAt ?? null,
    run_count: t.runCount,
    consecutive_failures: t.consecutiveFailures,
    created_at: t.createdAt,
  }
}

export function startAPIServer(config: APIConfig, deps: APIDeps) {
  const { host, port, bearerToken } = config

  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      // Auth (optional — skip when no token is configured)
      const url = new URL(req.url)
      const wantsPage =
        req.method === 'GET' &&
        url.pathname === '/' &&
        (req.headers.get('accept') ?? '').includes('text/html')

      // The page itself is served unauthenticated so the browser has somewhere to type the token;
      // every endpoint behind it still requires one. The page contains no data on its own.
      if (bearerToken && !wantsPage) {
        const auth = req.headers.get('authorization') ?? ''
        if (auth !== `Bearer ${bearerToken}`) return err('unauthorized', 401)
      }

      const path = url.pathname
      const method = req.method

      try {
        if (method === 'GET' && path === '/') {
          // A browser gets the chat page; anything else keeps the JSON it was getting before,
          // so scripts and health checks are unaffected by this existing at all.
          if ((req.headers.get('accept') ?? '').includes('text/html')) {
            return new Response(
              renderChatPage({
                name: deps.selfName ?? 'egirl',
                theme: getTheme(),
                hasToken: Boolean(bearerToken),
              }),
              { headers: { 'content-type': 'text/html; charset=utf-8' } },
            )
          }
          return json({ service: 'egirl', version: '0.2.0' })
        }

        // --- Chat ---
        if (method === 'POST' && path === '/chat') {
          const body = await readJson(req)
          const message = body.message
          if (typeof message !== 'string' || !message.trim()) {
            return err('message required')
          }
          const sessionId = (body.session_id as string | undefined) ?? 'api:default'
          const agent = getOrCreateAgent(sessionId, deps)
          const response = await agent.run(message)
          return json({
            content: response.content,
            session_id: sessionId,
            provider: response.provider,
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            turns: response.turns,
          })
        }

        // --- Peers (agent-to-agent, egirl-peer protocol — see docs/peers.md) ---
        if (method === 'GET' && path === '/peer/identity') {
          return json({
            service: 'egirl',
            protocol: PEER_PROTOCOL,
            name: deps.selfName ?? 'egirl',
          })
        }

        if (method === 'POST' && path === '/peer/message') {
          const body = await readJson(req)
          const from = body.from
          const message = body.message
          if (typeof from !== 'string' || !from.trim()) return err('from required')
          if (typeof message !== 'string' || !message.trim()) return err('message required')
          const protocol = body.protocol
          if (typeof protocol === 'string' && !protocol.startsWith('egirl-peer/')) {
            return err(`unsupported protocol "${protocol}" (this instance speaks ${PEER_PROTOCOL})`)
          }
          const sessionId = peerSessionId(from)
          const agent = getOrCreateAgent(sessionId, deps)
          const response = await agent.run(formatInboundPeerMessage(from, message))
          return json({
            protocol: PEER_PROTOCOL,
            from: deps.selfName ?? 'egirl',
            content: response.content,
            session_id: sessionId,
            turns: response.turns,
          })
        }

        // --- Sessions ---
        if (method === 'GET' && path.startsWith('/sessions/')) {
          const sessionId = path.slice('/sessions/'.length)
          const agent = deps.agents.get(sessionId)
          if (!agent) return err('session not found', 404)
          const ctx = agent.getContext()
          return json({
            session_id: ctx.sessionId,
            message_count: ctx.messages.length,
            has_summary: !!ctx.conversationSummary,
            messages: ctx.messages.map((m) => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            })),
          })
        }

        if (method === 'DELETE' && path.startsWith('/sessions/')) {
          const sessionId = path.slice('/sessions/'.length)
          const agent = deps.agents.get(sessionId)
          if (agent) {
            agent.resetSession()
            deps.agents.delete(sessionId)
          }
          return json({ ok: true })
        }

        // --- Memory ---
        if (method === 'GET' && path === '/memory') {
          if (!deps.memory) return err('memory disabled', 503)
          const q = url.searchParams.get('q') ?? ''
          const limit = Number(url.searchParams.get('limit') ?? 10)
          if (!q) return err('q required')
          const results = await deps.memory.searchFiltered(q, { limit })
          return json({
            results: results.map((r) => ({
              key: r.memory.key,
              value: r.memory.value,
              category: r.memory.category,
              score: r.score,
              created_at: r.memory.createdAt,
            })),
          })
        }

        if (method === 'POST' && path === '/memory') {
          if (!deps.memory) return err('memory disabled', 503)
          const body = await readJson(req)
          const key = body.key
          const value = body.value
          if (typeof key !== 'string' || typeof value !== 'string') {
            return err('key and value required')
          }
          const category = (body.category as MemoryCategory | undefined) ?? 'general'
          await deps.memory.set(key, value, { category, source: 'manual' })
          return json({ ok: true, key })
        }

        if (method === 'DELETE' && path.startsWith('/memory/')) {
          if (!deps.memory) return err('memory disabled', 503)
          const key = decodeURIComponent(path.slice('/memory/'.length))
          const deleted = deps.memory.delete(key)
          return json({ ok: deleted })
        }

        // --- Tasks ---
        if (method === 'GET' && path === '/tasks') {
          if (!deps.taskStore) return err('tasks disabled', 503)
          const status = url.searchParams.get('status') as Task['status'] | null
          const tasks = deps.taskStore.list(status ? { status } : undefined)
          return json({ tasks: tasks.map(taskToJson) })
        }

        if (method === 'POST' && path === '/tasks') {
          if (!deps.taskStore || !deps.taskRunner) {
            return err(`tasks disabled: ${deps.taskOffReason ?? 'no task runner'}`, 503)
          }
          const body = await readJson(req)
          if (typeof body.name !== 'string' || typeof body.prompt !== 'string') {
            return err('name and prompt required')
          }
          const task = deps.taskStore.create({
            name: body.name,
            description: (body.description as string) ?? body.name,
            prompt: body.prompt,
            kind: ((body.kind as string) ?? 'oneshot') as Task['kind'],
            intervalMs: body.interval_ms as number | undefined,
            cronExpression: body.cron as string | undefined,
            notify: 'always',
            channel: 'api',
            channelTarget: (body.session_id as string) ?? 'api:default',
            createdBy: 'user',
          })
          deps.taskRunner.activateTask(task.id)
          return json(taskToJson(task))
        }

        if (method === 'POST' && path.match(/^\/tasks\/[^/]+\/run$/)) {
          if (!deps.taskRunner) {
            return err(`tasks disabled: ${deps.taskOffReason ?? 'no task runner'}`, 503)
          }
          const id = path.split('/')[2] as string
          const run = await deps.taskRunner.runNow(id)
          if (!run) return err('task not found', 404)
          return json({
            status: run.status,
            result: run.result ?? null,
            error: run.error ?? null,
          })
        }

        return err('not found', 404)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.error('api', `Handler error: ${message}`, error)
        return err(message, 500)
      }
    },
  })

  log.info(
    'api',
    `HTTP API listening on http://${host}:${port}${bearerToken ? ' (bearer auth enabled)' : ''}`,
  )
  return server
}
