import { log } from '../../util/logger'
import type { EventSource, EventPayload } from '../types'

export interface WebhookConfig {
  path: string
  secret?: string
}

export interface WebhookRouter {
  addWebhookRoute(path: string, handler: (req: Request) => Promise<Response>): void
  removeWebhookRoute(path: string): void
}

async function verifyHmac(req: Request, secret: string): Promise<{ isValid: boolean; body: string }> {
  const body = await req.text()
  const signature = req.headers.get('x-hub-signature-256') ?? req.headers.get('x-signature')

  if (!signature) {
    return { isValid: false, body }
  }

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  const expected = 'sha256=' + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  return { isValid: signature === expected, body }
}

export function createWebhookSource(
  config: WebhookConfig,
  router: WebhookRouter,
): EventSource {
  let callback: ((payload: EventPayload) => void) | undefined

  const routePath = config.path.startsWith('/') ? config.path : `/${config.path}`

  return {
    start(onTrigger) {
      callback = onTrigger

      router.addWebhookRoute(routePath, async (req: Request) => {
        if (req.method !== 'POST') {
          return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        let body: string
        let data: unknown

        if (config.secret) {
          const result = await verifyHmac(req, config.secret)
          if (!result.isValid) {
            log.warn('tasks', `Webhook signature verification failed for ${routePath}`)
            return new Response(JSON.stringify({ error: 'Invalid signature' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          body = result.body
        } else {
          body = await req.text()
        }

        try {
          data = JSON.parse(body)
        } catch {
          data = body
        }

        if (callback) {
          callback({
            source: 'webhook',
            summary: `webhook received: POST ${routePath}`,
            data,
          })
        }

        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      })

      log.debug('tasks', `Webhook source registered: ${routePath}`)
    },

    stop() {
      router.removeWebhookRoute(routePath)
      callback = undefined
      log.debug('tasks', `Webhook source unregistered: ${routePath}`)
    },
  }
}
