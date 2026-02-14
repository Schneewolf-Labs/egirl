import type { AgentLoop } from '../agent'
import type { ToolExecutor } from '../tools'
import type { MemoryManager } from '../memory'
import type { RuntimeConfig } from '../config'
import type { ProviderRegistry } from '../providers'
import type { StatsTracker } from '../tracking/stats'
import { createRoutes, type RouteDeps } from './routes'
import { createBrowserRoutes } from './browser-routes'
import { buildOpenAPISpec } from './openapi'
import { log } from '../util/logger'
import type { BrowserManager } from '../browser'

export interface APIServerConfig {
  port: number
  host: string
}

export interface APIServerDeps {
  config: RuntimeConfig
  agent: AgentLoop
  toolExecutor: ToolExecutor
  memory: MemoryManager | undefined
  providers: ProviderRegistry
  stats: StatsTracker
  browser?: BrowserManager
}

export class APIServer {
  private server: ReturnType<typeof Bun.serve> | null = null
  private serverConfig: APIServerConfig
  private routes: ReturnType<typeof createRoutes>

  constructor(serverConfig: APIServerConfig, deps: APIServerDeps) {
    this.serverConfig = serverConfig

    const spec = buildOpenAPISpec(serverConfig.host, serverConfig.port)

    const routeDeps: RouteDeps = {
      ...deps,
      spec,
      startTime: Date.now(),
    }

    this.routes = createRoutes(routeDeps)

    // Merge browser routes if BrowserManager provided
    if (deps.browser) {
      const browserRoutes = createBrowserRoutes(deps.browser)
      for (const [path, methods] of browserRoutes) {
        if (!this.routes.has(path)) {
          this.routes.set(path, new Map())
        }
        for (const [method, handler] of methods) {
          this.routes.get(path)!.set(method, handler)
        }
      }
    }
  }

  start(): void {
    const { port, host } = this.serverConfig

    this.server = Bun.serve({
      port,
      hostname: host,
      fetch: (req) => this.handleRequest(req),
    })

    log.info('api', `API server listening on http://${host}:${port}`)
    log.info('api', `OpenAPI spec at http://${host}:${port}/openapi.json`)
  }

  stop(): void {
    this.server?.stop()
    this.server = null
    log.info('api', 'API server stopped')
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const method = req.method
    const path = url.pathname

    log.debug('api', `${method} ${path}`)

    // Try exact match first
    const exactMethods = this.routes.get(path)
    if (exactMethods) {
      const handler = exactMethods.get(method)
      if (handler) {
        return handler(req, {})
      }
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Try parameterized routes
    for (const [pattern, methods] of this.routes) {
      const params = matchRoute(pattern, path)
      if (params) {
        const handler = methods.get(method)
        if (handler) {
          return handler(req, params)
        }
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

/**
 * Match a route pattern like /v1/tools/:name/execute against a path.
 * Returns extracted params or null if no match.
 */
function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/')
  const pathParts = path.split('/')

  if (patternParts.length !== pathParts.length) return null

  const params: Record<string, string> = {}

  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]!
    const pathPart = pathParts[i]!

    if (pp.startsWith(':')) {
      params[pp.slice(1)] = decodeURIComponent(pathPart)
    } else if (pp !== pathPart) {
      return null
    }
  }

  return params
}

export function createAPIServer(serverConfig: APIServerConfig, deps: APIServerDeps): APIServer {
  return new APIServer(serverConfig, deps)
}
