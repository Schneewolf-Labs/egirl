import type { AgentFactory, AgentLoop } from './agent'
import { buildLearnPrompt } from './agent/learn-prompt'
import type { RuntimeConfig } from './config'
import type { SessionInfo } from './conversation'
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
  /** Read-only view of what this process is running, for GET /info. */
  config?: RuntimeConfig
  /**
   * Session listing for GET /sessions. The in-process agents map only knows sessions this
   * server has touched; the store knows every conversation from every channel, which is what
   * a session picker actually wants to show.
   */
  conversationStore?: { listSessions(): SessionInfo[] }
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
    max_turns: t.maxTurns ?? null,
    unbounded: t.unbounded,
    persist_conversation: t.persistConversation,
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

  // Per-session run chains. agent.run() deliberately does not serialize (the mutex guards
  // only tool execution, so separate sessions can batch on the server) -- which means two
  // POST /chat requests on the SAME session would interleave their turns into one context.
  // Chaining requests per session turns "send while she is working" into a queue, the same
  // contract the CLI gives typed-ahead input. `pending` is how many turns are waiting or
  // running, so the UI can say "queued" honestly instead of guessing.
  const chains = new Map<string, { tail: Promise<unknown>; pending: number }>()

  function enqueueRun<T>(
    sessionId: string,
    run: () => Promise<T>,
  ): { done: Promise<T>; position: number } {
    const chain = chains.get(sessionId) ?? { tail: Promise.resolve(), pending: 0 }
    const position = chain.pending
    chain.pending++
    // The tail never rejects (see below), so chaining directly off it is safe.
    const done = chain.tail.then(run)
    // Settle before bookkeeping: swallowing the rejection HERE is what keeps one failed turn
    // from poisoning every turn queued behind it, and keeps `done` -- which the handler
    // awaits -- the only place the error surfaces. A bare .finally(done) would mint a second,
    // unhandled copy of the rejection.
    chain.tail = done
      .then(
        () => {},
        () => {},
      )
      .then(() => {
        chain.pending--
        if (chain.pending <= 0) chains.delete(sessionId)
      })
    chains.set(sessionId, chain)
    return { done, position }
  }

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
          // /learn works from every surface the same way: rewrite the input, run a normal
          // turn. The agent distills and saves the skill with its own tools.
          const skillsDir = deps.config?.skills.dirs[0]
          const toRun =
            skillsDir && (message === '/learn' || message.startsWith('/learn '))
              ? buildLearnPrompt(message.slice('/learn'.length), skillsDir)
              : message
          // Attached images: data: URLs only, capped at 4. A remote URL here would have the
          // agent's server fetching arbitrary addresses on behalf of whoever holds the token.
          const images = Array.isArray(body.images)
            ? (body.images as unknown[])
                .filter((u): u is string => typeof u === 'string' && u.startsWith('data:image/'))
                .slice(0, 4)
            : undefined
          const { done, position } = enqueueRun(sessionId, () =>
            agent.run(toRun, images?.length ? { images } : {}),
          )
          const response = await done
          return json({
            content: response.content,
            session_id: sessionId,
            provider: response.provider,
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            turns: response.turns,
            // How many turns ran before this one got its slot; 0 means it ran immediately.
            queued_behind: position,
          })
        }

        // --- Introspection -------------------------------------------------
        // What this process actually is. The console shows it because a chat window with no
        // identity is indistinguishable from any other instance's, and getting that wrong means
        // talking to the wrong agent without noticing.
        if (method === 'GET' && path === '/info') {
          const cfg = deps.config
          return json({
            name: deps.selfName ?? 'egirl',
            instance: cfg?.source.instance ?? null,
            persona: cfg?.source.persona ?? null,
            profile: cfg?.source.profile ?? null,
            theme: cfg?.theme ?? null,
            workspace: cfg?.workspace.path ?? null,
            model: cfg?.local.model ?? null,
            endpoint: cfg?.local.endpoint ?? null,
            contextLength: cfg?.local.contextLength ?? null,
            auxiliary: cfg?.local.auxiliary
              ? { model: cfg.local.auxiliary.model, endpoint: cfg.local.auxiliary.endpoint }
              : null,
            memory: Boolean(deps.memory),
            embeddings: cfg?.local.embeddings
              ? { model: cfg.local.embeddings.model, dimensions: cfg.local.embeddings.dimensions }
              : null,
            tools: cfg?.tools ?? null,
            codeAgent: cfg?.channels.codeAgent?.provider ?? null,
            thinking: cfg?.thinking.level ?? null,
            permissions: cfg
              ? {
                  mode: cfg.permissionSupervisor.mode,
                  defaultAction: cfg.permissionSupervisor.defaultAction,
                }
              : null,
          })
        }

        // The composed system prompt -- IDENTITY, SOUL, AGENTS, USER and tool descriptions as the
        // model actually receives them. Reading it is the fastest way to understand why an agent
        // behaves the way it does, and it was previously only visible through the CLI.
        if (method === 'GET' && path === '/prompt') {
          const sessionId = url.searchParams.get('session_id') ?? 'api:default'
          const agent = getOrCreateAgent(sessionId, deps)
          const ctx = agent.getContext()
          return json({
            systemPrompt: ctx.systemPrompt,
            length: ctx.systemPrompt.length,
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
          const response = await enqueueRun(sessionId, () =>
            agent.run(formatInboundPeerMessage(from, message)),
          ).done
          return json({
            protocol: PEER_PROTOCOL,
            from: deps.selfName ?? 'egirl',
            content: response.content,
            session_id: sessionId,
            turns: response.turns,
          })
        }

        // --- Sessions ---
        // Every conversation from every channel, newest first -- the CLI session started on the
        // train shows up here so the browser at work can pick it up. The store is the source of
        // truth; the chains map layers on what is running right now.
        if (method === 'GET' && path === '/sessions') {
          const persisted = deps.conversationStore?.listSessions() ?? []
          const seen = new Set(persisted.map((s) => s.id))
          const sessions: JSONValue[] = persisted.map((s) => ({
            id: s.id,
            channel: s.channel,
            message_count: s.messageCount,
            last_active_at: s.lastActiveAt,
            busy: chains.has(s.id),
          }))
          // In-memory agents the store has not persisted (persistence off, or nothing said yet).
          for (const id of deps.agents.keys()) {
            if (seen.has(id)) continue
            sessions.push({
              id,
              channel: id.split(':')[0] ?? 'api',
              message_count: deps.agents.get(id)?.getContext().messages.length ?? 0,
              last_active_at: null,
              busy: chains.has(id),
            })
          }
          return json({ sessions })
        }

        if (method === 'GET' && path.startsWith('/sessions/')) {
          const sessionId = decodeURIComponent(path.slice('/sessions/'.length))
          // Hydrate from disk for sessions the store knows -- opening a CLI conversation in
          // the browser must load its history, not 404 because this server never touched it.
          // Unknown ids still 404: a GET that conjures sessions out of typos would make the
          // list fill with ghosts.
          let agent = deps.agents.get(sessionId)
          if (!agent) {
            const known = deps.conversationStore?.listSessions().some((s) => s.id === sessionId)
            if (known) agent = getOrCreateAgent(sessionId, deps)
          }
          if (!agent) return err('session not found', 404)
          const ctx = agent.getContext()
          return json({
            session_id: ctx.sessionId,
            message_count: ctx.messages.length,
            has_summary: !!ctx.conversationSummary,
            busy: chains.has(sessionId),
            messages: ctx.messages.map((m) => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            })),
          })
        }

        // Reach into a running loop: abort it, or inject an operator message it will see at
        // the next turn boundary. This is the background-run version of pressing esc in the
        // TTY — the piece that makes "the human can always stop the loop" true for unattended
        // runs. task:* sessions live inside the task runner, not this server's agents map.
        {
          const m = method === 'POST' && path.match(/^\/sessions\/(.+)\/interrupt$/)
          if (m) {
            const sessionId = decodeURIComponent(m[1] as string)
            const body = await readJson(req)
            const action = body.action
            if (action !== 'abort' && action !== 'inject') {
              return err("action must be 'abort' or 'inject'")
            }
            const message = body.message
            if (action === 'inject' && (typeof message !== 'string' || !message.trim())) {
              return err('message required for inject')
            }
            let delivered = false
            if (sessionId.startsWith('task:') && deps.taskRunner) {
              const taskId = sessionId.slice('task:'.length)
              delivered =
                action === 'abort'
                  ? deps.taskRunner.abortTask(taskId)
                  : deps.taskRunner.injectTask(taskId, message as string)
            } else {
              const agent = deps.agents.get(sessionId)
              if (agent) {
                delivered = action === 'abort' ? agent.interrupt() : agent.inject(message as string)
              }
            }
            // delivered=false means nothing was running — for inject, the caller should send
            // a normal chat message instead.
            return json({ ok: true, delivered })
          }
        }

        if (method === 'DELETE' && path.startsWith('/sessions/')) {
          const sessionId = decodeURIComponent(path.slice('/sessions/'.length))
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
            maxTurns: body.max_turns as number | undefined,
            unbounded: body.unbounded === true,
            persistConversation: body.persist_conversation === true,
            notify: 'always',
            channel: 'api',
            channelTarget: (body.session_id as string) ?? 'api:default',
            createdBy: 'user',
          })
          deps.taskRunner.activateTask(task.id)
          return json(taskToJson(task))
        }

        // Lifecycle over HTTP — the same operations the task_* tools give the agent, for the
        // human. Retiring a task used to mean editing tasks.db by hand.
        if (method === 'POST' && path.match(/^\/tasks\/[^/]+\/pause$/)) {
          if (!deps.taskStore) return err('tasks disabled', 503)
          const id = path.split('/')[2] as string
          const task = deps.taskStore.get(id)
          if (!task) return err('task not found', 404)
          deps.taskStore.update(id, { status: 'paused' }, 'paused via API')
          return json({ ok: true, id, status: 'paused' })
        }

        if (method === 'POST' && path.match(/^\/tasks\/[^/]+\/resume$/)) {
          if (!deps.taskStore) return err('tasks disabled', 503)
          const id = path.split('/')[2] as string
          const task = deps.taskStore.get(id)
          if (!task) return err('task not found', 404)
          deps.taskStore.update(
            id,
            { status: 'active', consecutiveFailures: 0, lastErrorKind: undefined },
            'resumed via API',
          )
          deps.taskRunner?.activateTask(id)
          return json({ ok: true, id, status: 'active' })
        }

        if (method === 'DELETE' && path.match(/^\/tasks\/[^/]+$/)) {
          if (!deps.taskStore) return err('tasks disabled', 503)
          const id = path.split('/')[2] as string
          const task = deps.taskStore.get(id)
          if (!task) return err('task not found', 404)
          // A running instance is aborted first so the delete doesn't leave an orphaned run
          // writing results for a task that no longer exists.
          const aborted = deps.taskRunner?.abortTask(id) ?? false
          deps.taskStore.delete(id)
          return json({ ok: true, id, aborted_running: aborted })
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
