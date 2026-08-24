/**
 * Web Push: how an agent reaches a phone that is not looking at the console.
 *
 * The console is a pull surface — it shows everything, but only once you open it. An agent that
 * parks waiting on an answer at 2am has no way to say so. This is the push half, and it is the
 * one channel that does not need the instance to be reachable from the internet: the *server*
 * connects outbound to the browser's push service, which delivers to the device wherever it is.
 * Nothing has to be exposed inbound for a notification to arrive.
 *
 * Notifications carry no content by design — see the note in vapid.ts.
 */

import { Database } from 'bun:sqlite'
import { log } from '../util/logger'
import { subscriptionId, type VapidKeys, vapidAuthHeader } from './vapid'

export interface PushSubscription {
  endpoint: string
  /** Kept for a future encrypted-payload path; unused while pushes are payload-free. */
  p256dh?: string
  auth?: string
  createdAt: number
}

export class PushStore {
  private db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT,
      auth TEXT,
      created_at INTEGER NOT NULL
    )`)
    this.db.run(`CREATE TABLE IF NOT EXISTS push_keys (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL
    )`)
  }

  /**
   * The instance's VAPID pair, generated once and reused. Regenerating would silently break
   * every subscription already issued, since the browser bound each one to the old key.
   */
  keys(generate: () => VapidKeys): VapidKeys {
    const row = this.db.query('SELECT public_key, private_key FROM push_keys WHERE id = 1').get() as
      | { public_key: string; private_key: string }
      | undefined
    if (row) return { publicKey: row.public_key, privateKey: row.private_key }
    const fresh = generate()
    this.db.run('INSERT INTO push_keys (id, public_key, private_key) VALUES (1, ?, ?)', [
      fresh.publicKey,
      fresh.privateKey,
    ])
    return fresh
  }

  subscribe(sub: { endpoint: string; p256dh?: string; auth?: string }): void {
    this.db.run(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      [sub.endpoint, sub.p256dh ?? null, sub.auth ?? null, Date.now()],
    )
  }

  unsubscribe(endpoint: string): void {
    this.db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint])
  }

  list(): PushSubscription[] {
    const rows = this.db
      .query('SELECT endpoint, p256dh, auth, created_at FROM push_subscriptions')
      .all() as Array<{
      endpoint: string
      p256dh: string | null
      auth: string | null
      created_at: number
    }>
    return rows.map((r) => ({
      endpoint: r.endpoint,
      p256dh: r.p256dh ?? undefined,
      auth: r.auth ?? undefined,
      createdAt: r.created_at,
    }))
  }
}

export interface PushNotifier {
  /** Wake every subscribed device. Returns how many were reached. */
  notify(reason: string): Promise<number>
  /** VAPID public key, handed to the browser at subscribe time. */
  publicKey(): string
}

export function createPushNotifier(
  store: PushStore,
  keys: VapidKeys,
  subject: string,
): PushNotifier {
  return {
    publicKey: () => keys.publicKey,
    async notify(reason: string): Promise<number> {
      const subs = store.list()
      if (!subs.length) return 0
      let delivered = 0
      await Promise.all(
        subs.map(async (sub) => {
          try {
            const audience = new URL(sub.endpoint).origin
            const res = await fetch(sub.endpoint, {
              method: 'POST',
              headers: {
                Authorization: vapidAuthHeader(keys, audience, subject),
                // No body: the service worker fetches the real content from the console. TTL
                // keeps a notification from arriving hours stale if the device is off.
                TTL: '600',
                'Content-Length': '0',
              },
            })
            if (res.ok) {
              delivered++
              return
            }
            // 404/410 mean the browser dropped this subscription — it will never work again,
            // so prune it rather than retrying it forever on every future notification.
            if (res.status === 404 || res.status === 410) {
              store.unsubscribe(sub.endpoint)
              log.info('push', `Subscription ${subscriptionId(sub.endpoint)} expired — removed`)
            } else {
              log.warn('push', `Push to ${subscriptionId(sub.endpoint)} failed: HTTP ${res.status}`)
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            log.warn('push', `Push to ${subscriptionId(sub.endpoint)} failed: ${msg}`)
          }
        }),
      )
      if (delivered) log.info('push', `Notified ${delivered} device(s): ${reason}`)
      return delivered
    },
  }
}

export { generateVapidKeys } from './vapid'
