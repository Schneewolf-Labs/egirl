import { timingSafeEqual } from 'crypto'
import type { AgentLoop } from '../agent'
import type { BrowserManager } from '../browser'
import type { RuntimeConfig } from '../config'
import type { MemoryManager } from '../memory'
import type { ProviderRegistry } from '../providers'
import type { ToolExecutor } from '../tools'
import type { StatsTracker } from '../tracking/stats'
import { log } from '../util/logger'
import { createBrowserRoutes } from './browser-routes'
import { buildOpenAPISpec } from './openapi'
import { createRoutes, type RouteDeps } from './routes'

export interface APIServerConfig {
  port: number
  host: string
  bearerToken?: string
  maxRequestBytes?: number
  rateLimitPerMinute?: number
  corsOrigins?: string[]
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

/** Simple sliding-window rate limiter keyed by IP */
class RateLimiter {
  private requests: Map<string, number[]> = new Map()
  private windowMs = 60_000

  constructor(private maxPerWindow: number) {}

  isAllowed(ip: string): boolean {
    const now = Date.now()
    const cutoff = now - this.windowMs

    let timestamps = this.requests.get(ip)
    if (!timestamps) {
      timestamps = []
      this.requests.set(ip, timestamps)
    }

    // Prune old entries
    while (timestamps.length > 0 && (timestamps[0] ?? 0) < cutoff) {
      timestamps.shift()
    }

    if (timestamps.length >= this.maxPerWindow) {
      return false
    }

    timestamps.push(now)
    return true
  }

  /** Periodic cleanup of stale entries */
  cleanup(): void {
    const cutoff = Date.now() - this.windowMs
    for (const [ip, timestamps] of this.requests) {
      while (timestamps.length > 0 && (timestamps[0] ?? 0) < cutoff) {
        timestamps.shift()
      }
      if (timestamps.length === 0) {
        this.requests.delete(ip)
      }
    }
  }
}

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 // 64 KB
const DEFAULT_RATE_LIMIT = 30 // requests per minute

/** Auth-exempt paths that return minimal info */
const PUBLIC_PATHS = new Set(['/health'])

/** Security headers applied to every response */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
}

/**
 * Constant-time string comparison to prevent timing attacks on token auth.
 * Returns true if a === b without leaking length/content via timing.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    // Still do comparison to avoid leaking length info via timing
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

export class APIServer {
  private server: ReturnType<typeof Bun.serve> | null = null
  private serverConfig: APIServerConfig
  private routes: ReturnType<typeof createRoutes>
  private rateLimiter: RateLimiter
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private allowedOrigins: Set<string>

  constructor(serverConfig: APIServerConfig, deps: APIServerDeps) {
    this.serverConfig = serverConfig
    this.rateLimiter = new RateLimiter(serverConfig.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT)
    this.allowedOrigins = new Set(serverConfig.corsOrigins ?? [])

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
          this.routes.get(path)?.set(method, handler)
        }
      }
    }

    if (serverConfig.bearerToken) {
      log.info('api', 'API key authentication enabled')
    } else {
      log.warn('api', 'No API key configured — all requests are unauthenticated')
    }
  }

  start(): void {
    const { port, host } = this.serverConfig

    this.server = Bun.serve({
      port,
      hostname: host,
      fetch: (req) => this.handleRequest(req),
    })

    // Periodic cleanup of rate limiter state
    this.cleanupInterval = setInterval(() => this.rateLimiter.cleanup(), 60_000)

    log.info('api', `API server listening on http://${host}:${port}`)
    log.info('api', `Dashboard at http://${host}:${port}/`)
    log.info('api', `OpenAPI spec at http://${host}:${port}/openapi.json`)
  }

  stop(): void {
    this.server?.stop()
    this.server = null
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    log.info('api', 'API server stopped')
  }

  private corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get('origin')
    if (!origin) return {}

    // If no origins configured, reject all cross-origin requests
    if (this.allowedOrigins.size === 0) return {}

    // Only allow explicitly whitelisted origins
    if (!this.allowedOrigins.has(origin)) return {}

    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  }

  private applyHeaders(res: Response, req: Request): Response {
    // Security headers
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      res.headers.set(k, v)
    }
    // CORS headers
    const cors = this.corsHeaders(req)
    for (const [k, v] of Object.entries(cors)) {
      res.headers.set(k, v)
    }
    return res
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const method = req.method
    const path = url.pathname
    const ip = this.server?.requestIP(req)?.address ?? 'unknown'

    log.debug('api', `${method} ${path} from ${ip}`)

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...SECURITY_HEADERS, ...this.corsHeaders(req) },
      })
    }

    const res = await this.routeRequest(req, method, path, ip)
    return this.applyHeaders(res, req)
  }

  private async routeRequest(
    req: Request,
    method: string,
    path: string,
    ip: string,
  ): Promise<Response> {
    // Bearer token auth (skip for public paths)
    if (this.serverConfig.bearerToken && !PUBLIC_PATHS.has(path)) {
      const authHeader = req.headers.get('authorization')
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined

      if (!token || !safeEqual(token, this.serverConfig.bearerToken)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // Rate limiting
    if (!this.rateLimiter.isAllowed(ip)) {
      log.warn('api', `Rate limit exceeded for ${ip}`)
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
        },
      })
    }

    // Request size limit (for POST/PUT/PATCH)
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const contentLength = req.headers.get('content-length')
      const maxBytes = this.serverConfig.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
      if (contentLength && Number(contentLength) > maxBytes) {
        return new Response(JSON.stringify({ error: 'Request body too large' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

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
    const pp = patternParts[i]
    const pathPart = pathParts[i]
    if (pp === undefined || pathPart === undefined) return null

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
