/**
 * Web Push — the one channel that reaches a device nobody is looking at.
 *
 * Two properties matter enough to pin down. First, the VAPID header has to be a *genuinely
 * valid* ES256 JWT: a subtly wrong signature is accepted by every test that only checks the
 * shape of the string and rejected by every real push service, so these verify the signature
 * against the public key rather than pattern-matching it. Second, notifications must stay
 * payload-free — the whole privacy argument for this design is that the push service learns
 * that a ping happened and never what it said.
 */

import { describe, expect, test } from 'bun:test'
import { createPublicKey, createVerify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPushNotifier, generateVapidKeys, PushStore } from '../../src/push'
import { vapidAuthHeader } from '../../src/push/vapid'

/** Verify a JWS ES256 signature, converting JOSE r||s back into the DER the verifier wants. */
function jwtIsValid(token: string, publicKeyB64: string): boolean {
  const [header, claims, sig] = token.split('.')
  const raw = Buffer.from(sig as string, 'base64url')
  const trim = (b: Buffer): Buffer => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    const out = b.subarray(i)
    return (out[0] as number) & 0x80 ? Buffer.concat([Buffer.from([0]), out]) : out
  }
  const r = trim(raw.subarray(0, 32))
  const s = trim(raw.subarray(32))
  const der = Buffer.concat([
    Buffer.from([0x30, r.length + s.length + 4, 0x02, r.length]),
    r,
    Buffer.from([0x02, s.length]),
    s,
  ])
  const spki = Buffer.concat([
    Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
    Buffer.from(publicKeyB64, 'base64url'),
  ])
  const verifier = createVerify('SHA256')
  verifier.update(`${header}.${claims}`)
  return verifier.verify(createPublicKey({ key: spki, format: 'der', type: 'spki' }), der)
}

describe('VAPID', () => {
  test('produces a signature a push service will actually accept', () => {
    const keys = generateVapidKeys()
    const header = vapidAuthHeader(keys, 'https://fcm.googleapis.com', 'mailto:a@b.c')
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header)
    expect(m).not.toBeNull()
    const token = (m as RegExpExecArray)[1] as string
    // The DER->JOSE conversion is the part that silently produces plausible-but-invalid
    // signatures, so this verifies cryptographically rather than checking the string shape.
    expect(jwtIsValid(token, keys.publicKey)).toBe(true)
    expect((m as RegExpExecArray)[2]).toBe(keys.publicKey)
  })

  test('scopes the token to the push service it is being sent to', () => {
    // A token minted for one service must not be replayable at another, which is what `aud`
    // is for. Getting this wrong turns a leaked header into a general-purpose credential.
    const keys = generateVapidKeys()
    const header = vapidAuthHeader(keys, 'https://web.push.apple.com', 'mailto:a@b.c')
    const claims = JSON.parse(
      Buffer.from(
        (/vapid t=[^.]+\.([^.]+)\./.exec(header) as RegExpExecArray)[1] as string,
        'base64url',
      ).toString(),
    )
    expect(claims.aud).toBe('https://web.push.apple.com')
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
    // Spec caps this at 24h; a long-lived token is a long-lived liability.
    expect(claims.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 24 * 60 * 60)
  })
})

describe('push delivery', () => {
  /** A push service stand-in that records the request and replies with `status`. */
  function fakeService(status = 201) {
    const seen: Array<{ auth: string | null; ttl: string | null; bodyBytes: number }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({
          auth: req.headers.get('authorization'),
          ttl: req.headers.get('ttl'),
          bodyBytes: (await req.arrayBuffer()).byteLength,
        })
        return new Response('', { status })
      },
    })
    return { seen, url: `http://127.0.0.1:${server.port}/push/x`, stop: () => server.stop(true) }
  }

  test('sends a signed, contentless notification', async () => {
    const svc = fakeService()
    try {
      const store = new PushStore(':memory:')
      store.subscribe({ endpoint: svc.url })
      const notifier = createPushNotifier(store, generateVapidKeys(), 'mailto:a@b.c')
      expect(await notifier.notify('test')).toBe(1)
      expect(svc.seen.length).toBe(1)
      expect(svc.seen[0]?.auth).toMatch(/^vapid t=.+, k=.+$/)
      expect(svc.seen[0]?.ttl).toBe('600')
      // The point of the whole design: the push service carries no content.
      expect(svc.seen[0]?.bodyBytes).toBe(0)
    } finally {
      svc.stop()
    }
  })

  test('forgets a subscription the browser has dropped', async () => {
    // 410 Gone is permanent. Keeping it would mean re-attempting a dead endpoint on every
    // future notification, forever, for a device that no longer exists.
    const svc = fakeService(410)
    try {
      const store = new PushStore(':memory:')
      store.subscribe({ endpoint: svc.url })
      const notifier = createPushNotifier(store, generateVapidKeys(), 'mailto:a@b.c')
      expect(await notifier.notify('test')).toBe(0)
      expect(store.list().length).toBe(0)
    } finally {
      svc.stop()
    }
  })

  test('one unreachable device does not stop the others being notified', async () => {
    const good = fakeService()
    try {
      const store = new PushStore(':memory:')
      store.subscribe({ endpoint: 'http://127.0.0.1:1/dead' }) // nothing listening
      store.subscribe({ endpoint: good.url })
      const notifier = createPushNotifier(store, generateVapidKeys(), 'mailto:a@b.c')
      expect(await notifier.notify('test')).toBe(1)
      expect(good.seen.length).toBe(1)
      // A transport error is not proof the subscription is dead, so it is kept.
      expect(store.list().length).toBe(2)
    } finally {
      good.stop()
    }
  })

  test('keeps its VAPID keys across restarts', () => {
    // Regenerating would invalidate every subscription already issued, because the browser
    // bound each one to the old key -- silently, with no error anywhere.
    const dir = mkdtempSync(join(tmpdir(), 'egirl-push-'))
    const path = join(dir, 'push.db')
    const firstStore = new PushStore(path)
    const secondStore = new PushStore(path)
    try {
      const first = firstStore.keys(generateVapidKeys)
      firstStore.close()
      const second = secondStore.keys(generateVapidKeys)
      expect(second.publicKey).toBe(first.publicKey)
    } finally {
      firstStore.close()
      secondStore.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
