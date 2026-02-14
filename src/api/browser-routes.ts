import type { BrowserManager } from '../browser'
import { log } from '../util/logger'

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

/**
 * Create browser automation HTTP routes.
 * These provide a clean REST API wrapping the BrowserManager.
 *
 * Routes:
 *   POST /v1/browser/navigate   { url }
 *   POST /v1/browser/click      { target }
 *   POST /v1/browser/fill       { target, value }
 *   POST /v1/browser/select     { target, value }
 *   POST /v1/browser/check      { target, checked? }
 *   POST /v1/browser/hover      { target }
 *   POST /v1/browser/wait       { target, timeout? }
 *   POST /v1/browser/eval       { expression }
 *   GET  /v1/browser/snapshot
 *   GET  /v1/browser/screenshot
 *   GET  /v1/browser/status
 *   POST /v1/browser/close
 */
export function createBrowserRoutes(
  manager: BrowserManager,
): Map<string, Map<string, RouteHandler>> {
  const routes = new Map<string, Map<string, RouteHandler>>()

  function route(method: string, path: string, handler: RouteHandler): void {
    if (!routes.has(path)) {
      routes.set(path, new Map())
    }
    routes.get(path)!.set(method, handler)
  }

  // POST /v1/browser/navigate
  route('POST', '/v1/browser/navigate', async (req) => {
    const body = await parseBody(req) as { url?: string } | null
    if (!body?.url) {
      return error('Missing required field: url')
    }

    if (!body.url.startsWith('http://') && !body.url.startsWith('https://')) {
      return error('URL must start with http:// or https://')
    }

    try {
      const snap = await manager.navigate(body.url)
      return json({ success: true, ...snap })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('browser-api', `Navigate error: ${message}`)
      return error(message, 500)
    }
  })

  // POST /v1/browser/click
  route('POST', '/v1/browser/click', async (req) => {
    const body = await parseBody(req) as { target?: string } | null
    if (!body?.target) {
      return error('Missing required field: target')
    }

    try {
      const snap = await manager.click(body.target)
      return json({ success: true, ...snap })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('browser-api', `Click error: ${message}`)
      return error(message, 500)
    }
  })

  // POST /v1/browser/fill
  route('POST', '/v1/browser/fill', async (req) => {
    const body = await parseBody(req) as { target?: string; value?: string } | null
    if (!body?.target) {
      return error('Missing required field: target')
    }
    if (body.value === undefined || body.value === null) {
      return error('Missing required field: value')
    }

    try {
      const snap = await manager.fill(body.target, body.value)
      return json({ success: true, ...snap })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('browser-api', `Fill error: ${message}`)
      return error(message, 500)
    }
  })

  // POST /v1/browser/select
  route('POST', '/v1/browser/select', async (req) => {
    const body = await parseBody(req) as { target?: string; value?: string } | null
    if (!body?.target) {
      return error('Missing required field: target')
    }
    if (!body?.value) {
      return error('Missing required field: value')
    }

    try {
      const snap = await manager.selectOption(body.target, body.value)
      return json({ success: true, ...snap })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('browser-api', `Select error: ${message}`)
      return error(message, 500)
    }
  })

  // POST /v1/browser/check
  route('POST', '/v1/browser/check', async (req) => {
    const body = await parseBody(req) as { target?: string; checked?: boolean } | null
    if (!body?.target) {
      return error('Missing required field: target')
    }

    const checked = body.checked ?? true

    try {
      const snap = checked
        ? await manager.check(body.target)
        : await manager.uncheck(body.target)
      return json({ success: true, ...snap })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('browser-api', `Check error: ${message}`)
      return error(message, 500)
    }
  })

  // POST /v1/browser/hover
  route('POST', '/v1/browser/hover', async (req) => {
    const body = await parseBody(req) as { target?: string } | null
    if (!body?.target) {
      return error('Missing required field: target')
    }

    try {
      const snap = await manager.hover(body.target)
      return json({ success: true, ...snap })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('browser-api', `Hover error: ${message}`)
      return error(message, 500)
    }
  })

  // POST /v1/browser/wait
  route('POST', '/v1/browser/wait', async (req) => {
    const body = await parseBody(req) as { target?: string; timeout?: number } | null
    if (!body?.target) {
      return error('Missing required field: target')
    }

    try {
      const snap = await manager.waitFor(body.target, body.timeout)
      return json({ success: true, ...snap })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('browser-api', `Wait error: ${message}`)
      return error(message, 500)
    }
  })

  // POST /v1/browser/eval
  route('POST', '/v1/browser/eval', async (req) => {
    const body = await parseBody(req) as { expression?: string } | null
    if (!body?.expression) {
      return error('Missing required field: expression')
    }

    try {
      const result = await manager.evaluate(body.expression)
      return json({ success: true, result })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('browser-api', `Eval error: ${message}`)
      return error(message, 500)
    }
  })

  // GET /v1/browser/snapshot
  route('GET', '/v1/browser/snapshot', async () => {
    try {
      const snap = await manager.snapshot()
      return json({ success: true, ...snap })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('browser-api', `Snapshot error: ${message}`)
      return error(message, 500)
    }
  })

  // GET /v1/browser/screenshot
  route('GET', '/v1/browser/screenshot', async () => {
    try {
      const dataUrl = await manager.screenshot()
      return json({ success: true, image: dataUrl })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('browser-api', `Screenshot error: ${message}`)
      return error(message, 500)
    }
  })

  // GET /v1/browser/status
  route('GET', '/v1/browser/status', async () => {
    return json({ open: manager.isOpen })
  })

  // POST /v1/browser/close
  route('POST', '/v1/browser/close', async () => {
    try {
      await manager.close()
      return json({ success: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('browser-api', `Close error: ${message}`)
      return error(message, 500)
    }
  })

  return routes
}
