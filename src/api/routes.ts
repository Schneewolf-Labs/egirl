import { join } from 'path'
import type { AgentLoop, AgentResponse } from '../agent'
import type { RuntimeConfig } from '../config'
import type { MemoryManager, SearchResult } from '../memory'
import type { ProviderRegistry } from '../providers'
import type { ToolExecutor } from '../tools'
import type { StatsTracker } from '../tracking/stats'
import { log } from '../util/logger'
import type { OpenAPISpec } from './openapi'

const STATIC_DIR = join(import.meta.dir, '../../static')

export interface RouteDeps {
  agent: AgentLoop
  toolExecutor: ToolExecutor
  memory: MemoryManager | undefined
  config: RuntimeConfig
  providers: ProviderRegistry
  stats: StatsTracker
  spec: OpenAPISpec
  startTime: number
}

type RouteHandler = (req: Request, params: Record<string, string>) => Promise<Response>

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status)
}

async function parseBody(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

export function createRoutes(deps: RouteDeps): Map<string, Map<string, RouteHandler>> {
  const routes = new Map<string, Map<string, RouteHandler>>()

  function route(method: string, path: string, handler: RouteHandler): void {
    if (!routes.has(path)) {
      routes.set(path, new Map())
    }
    routes.get(path)?.set(method, handler)
  }

  // GET / — HTML dashboard
  route('GET', '/', async () => {
    return new Response(Bun.file(join(STATIC_DIR, 'dashboard.html')))
  })

  // Static assets
  route('GET', '/static/dashboard.css', async () => {
    return new Response(Bun.file(join(STATIC_DIR, 'dashboard.css')))
  })

  route('GET', '/static/dashboard.js', async () => {
    return new Response(Bun.file(join(STATIC_DIR, 'dashboard.js')))
  })

  // GET /health — public, minimal info
  route('GET', '/health', async () => {
    return json({ status: 'ok' })
  })

  // GET /openapi.json
  route('GET', '/openapi.json', async () => {
    return json(deps.spec)
  })

  // POST /v1/chat
  route('POST', '/v1/chat', async (req) => {
    const body = (await parseBody(req)) as { message?: string; max_turns?: number } | null
    if (!body?.message) {
      return error('Missing required field: message')
    }

    try {
      const response: AgentResponse = await deps.agent.run(body.message, {
        maxTurns: body.max_turns,
      })

      deps.stats.recordRequest(
        response.target,
        response.provider,
        response.usage.input_tokens,
        response.usage.output_tokens,
        response.escalated,
      )

      return json({
        content: response.content,
        target: response.target,
        provider: response.provider,
        usage: response.usage,
        escalated: response.escalated,
        turns: response.turns,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('api', `Chat error: ${message}`)
      return error(message, 500)
    }
  })

  // GET /v1/tools
  route('GET', '/v1/tools', async () => {
    return json({ tools: deps.toolExecutor.getDefinitions() })
  })

  // POST /v1/tools/:name/execute
  route('POST', '/v1/tools/:name/execute', async (req, params) => {
    const name = params.name ?? ''
    const tool = deps.toolExecutor.get(name)
    if (!tool) {
      return error(`Unknown tool: ${name}`, 404)
    }

    const body = (await parseBody(req)) as {
      arguments?: Record<string, unknown>
      cwd?: string
    } | null
    const args = body?.arguments ?? {}
    const cwd = body?.cwd ?? deps.config.workspace.path

    try {
      const result = await tool.execute(args, cwd)
      return json({ success: result.success, output: result.output })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('api', `Tool ${name} error: ${message}`)
      return error(message, 500)
    }
  })

  // GET /v1/memory/:key
  route('GET', '/v1/memory/:key', async (_req, params) => {
    if (!deps.memory) {
      return error('Memory system not initialized', 503)
    }

    const key = params.key ?? ''
    const result = deps.memory.get(key)
    if (!result) {
      return error(`Memory not found: ${key}`, 404)
    }

    return json({ key, value: result.value, imagePath: result.imagePath })
  })

  // PUT /v1/memory/:key
  route('PUT', '/v1/memory/:key', async (req, params) => {
    if (!deps.memory) {
      return error('Memory system not initialized', 503)
    }

    const body = (await parseBody(req)) as { value?: string } | null
    if (!body?.value) {
      return error('Missing required field: value')
    }

    const key = params.key ?? ''
    await deps.memory.set(key, body.value)
    return json({ success: true })
  })

  // DELETE /v1/memory/:key
  route('DELETE', '/v1/memory/:key', async (_req, params) => {
    if (!deps.memory) {
      return error('Memory system not initialized', 503)
    }

    const key = params.key ?? ''
    const deleted = deps.memory.delete(key)
    return json({ deleted })
  })

  // POST /v1/memory/search
  route('POST', '/v1/memory/search', async (req) => {
    if (!deps.memory) {
      return error('Memory system not initialized', 503)
    }

    const body = (await parseBody(req)) as { query?: string; mode?: string; limit?: number } | null
    if (!body?.query) {
      return error('Missing required field: query')
    }

    const mode = body.mode ?? 'hybrid'
    const limit = body.limit ?? 10

    try {
      let results: SearchResult[]
      switch (mode) {
        case 'text':
          results = await deps.memory.searchText(body.query, limit)
          break
        case 'semantic':
          results = await deps.memory.searchSemantic(body.query, limit)
          break
        case 'hybrid':
          results = await deps.memory.searchHybrid(body.query, limit)
          break
        default:
          return error(`Invalid search mode: ${mode}. Use text, semantic, or hybrid`)
      }

      return json({
        results: results.map((r) => ({
          key: r.memory.key,
          value: r.memory.value,
          score: r.score,
          matchType: r.matchType,
        })),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('api', `Memory search error: ${message}`)
      return error(message, 500)
    }
  })

  // GET /v1/status
  route('GET', '/v1/status', async () => {
    const stats = deps.stats.getStats()

    return json({
      config: {
        workspace: deps.config.workspace.path,
        localModel: deps.config.local.model,
        localEndpoint: deps.config.local.endpoint,
        routingDefault: deps.config.routing.default,
        escalationThreshold: deps.config.routing.escalationThreshold,
        hasRemoteAnthropic: !!deps.config.remote.anthropic,
        hasRemoteOpenAI: !!deps.config.remote.openai,
        hasEmbeddings: !!deps.config.local.embeddings,
        hasMemory: !!deps.memory,
      },
      providers: {
        local: deps.providers.local.name,
        remote: deps.providers.remote?.name ?? null,
      },
      stats,
    })
  })

  // GET /v1/config — return current config (secrets masked)
  route('GET', '/v1/config', async () => {
    const c = deps.config
    return json({
      theme: c.theme,
      thinking: c.thinking,
      workspace: { path: c.workspace.path },
      local: {
        endpoint: c.local.endpoint,
        model: c.local.model,
        contextLength: c.local.contextLength,
        maxConcurrent: c.local.maxConcurrent,
        embeddings: c.local.embeddings
          ? {
              endpoint: c.local.embeddings.endpoint,
              model: c.local.embeddings.model,
              dimensions: c.local.embeddings.dimensions,
              multimodal: c.local.embeddings.multimodal,
            }
          : undefined,
      },
      remote: {
        hasAnthropic: !!c.remote.anthropic,
        hasOpenAI: !!c.remote.openai,
        anthropicModel: c.remote.anthropic?.model,
        openaiModel: c.remote.openai?.model,
      },
      routing: {
        default: c.routing.default,
        escalationThreshold: c.routing.escalationThreshold,
        alwaysLocal: c.routing.alwaysLocal,
        alwaysRemote: c.routing.alwaysRemote,
      },
      channels: {
        hasDiscord: !!c.channels.discord,
        discord: c.channels.discord
          ? {
              allowedChannels: c.channels.discord.allowedChannels,
              allowedUsers: c.channels.discord.allowedUsers,
              passiveChannels: c.channels.discord.passiveChannels,
              batchWindowMs: c.channels.discord.batchWindowMs,
            }
          : undefined,
        api: c.channels.api,
        claudeCode: c.channels.claudeCode
          ? {
              permissionMode: c.channels.claudeCode.permissionMode,
              model: c.channels.claudeCode.model,
              workingDir: c.channels.claudeCode.workingDir,
              maxTurns: c.channels.claudeCode.maxTurns,
            }
          : undefined,
        xmpp: c.channels.xmpp
          ? {
              service: c.channels.xmpp.service,
              domain: c.channels.xmpp.domain,
              resource: c.channels.xmpp.resource,
              allowedJids: c.channels.xmpp.allowedJids,
            }
          : undefined,
      },
      conversation: c.conversation,
      memory: c.memory,
      safety: c.safety,
      tasks: c.tasks,
      skills: { dirs: c.skills.dirs },
      transcript: c.transcript,
      hasGithub: !!c.github,
      github: c.github
        ? { defaultOwner: c.github.defaultOwner, defaultRepo: c.github.defaultRepo }
        : undefined,
    })
  })

  // PUT /v1/config — write TOML config to disk
  route('PUT', '/v1/config', async (req) => {
    const body = (await parseBody(req)) as Record<string, unknown> | null
    if (!body) {
      return error('Invalid request body')
    }

    try {
      const { writeConfigToml } = await import('../config/writer')
      await writeConfigToml(body)
      return json({ success: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('api', `Config write error: ${message}`)
      return error(message, 500)
    }
  })

  return routes
}
