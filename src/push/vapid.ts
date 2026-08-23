/**
 * VAPID — the half of Web Push that proves a notification came from this instance.
 *
 * Push is deliberately used here *without a payload*. A subscription carries the keys needed to
 * encrypt one, but sending the content through Apple's or Google's push service means handing
 * them the text of everything an agent ever needs you for. A payload-free push is a doorbell:
 * the service learns that this instance pinged this device and nothing else, the service worker
 * wakes up, and it fetches the actual content from the console over the instance's own TLS.
 *
 * That choice also removes the entire aes128gcm/ECDH encryption path, which is the complicated
 * and easy-to-get-subtly-wrong part of Web Push. What is left is a signed JWT, which is small
 * enough to do correctly with the standard crypto module and no dependency.
 */

import { createHash, createPrivateKey, createSign, generateKeyPairSync } from 'node:crypto'

export interface VapidKeys {
  /** Base64url P-256 public key, uncompressed point. Handed to the browser at subscribe time. */
  publicKey: string
  /** Base64url PKCS8 private key. Signs the JWT; never leaves the server. */
  privateKey: string
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/**
 * A fresh VAPID key pair. Generated once per instance and persisted: regenerating invalidates
 * every existing subscription, because the browser bound its subscription to the old key.
 */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  // The raw uncompressed point (0x04 || X || Y) is the last 65 bytes of the SPKI encoding.
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 65)
  return {
    publicKey: b64url(raw),
    privateKey: b64url(privateKey.export({ type: 'pkcs8', format: 'der' })),
  }
}

/** DER-encoded ECDSA signatures are variable-length; JWS wants a fixed 64-byte r||s. */
function derToJose(der: Buffer): Buffer {
  let offset = 2
  if (der[1] === undefined) throw new Error('malformed ECDSA signature')
  // Skip the outer SEQUENCE length byte(s) when the long form is used.
  if (der[1] & 0x80) offset += der[1] & 0x7f
  const readInt = (): Buffer => {
    const len = der[offset + 1] as number
    let start = offset + 2
    let size = len
    // Strip the leading zero DER adds to keep the integer positive.
    while (size > 32 && der[start] === 0) {
      start++
      size--
    }
    const out = Buffer.alloc(32)
    der.subarray(start, start + size).copy(out, 32 - size)
    offset = offset + 2 + len
    return out
  }
  const r = readInt()
  const s = readInt()
  return Buffer.concat([r, s])
}

/**
 * The `Authorization: vapid` header for one push. `audience` is the origin of the push service
 * (not our own origin) — a token minted for Apple's service is not valid at Google's, which is
 * what stops a leaked token from being replayed elsewhere.
 */
export function vapidAuthHeader(
  keys: VapidKeys,
  audience: string,
  subject: string,
  now = Date.now(),
): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        // 12h. The spec caps this at 24h; short-lived tokens limit the value of one leaking.
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: subject,
      }),
    ),
  )
  const signingInput = `${header}.${claims}`
  const key = createPrivateKey({
    key: fromB64url(keys.privateKey),
    format: 'der',
    type: 'pkcs8',
  })
  const signer = createSign('SHA256')
  signer.update(signingInput)
  const signature = b64url(derToJose(signer.sign(key)))
  return `vapid t=${signingInput}.${signature}, k=${keys.publicKey}`
}

/** Stable short id for a subscription endpoint, for logging without recording the full URL. */
export function subscriptionId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 12)
}
