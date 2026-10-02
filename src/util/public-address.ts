import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Whether an IP literal is somewhere a stranger shouldn't be able to make us fetch from:
 * loopback, private, CGNAT (Tailscale lives here), link-local (cloud metadata), multicast,
 * reserved, or unspecified. Anything that isn't a valid IP counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isPrivateV4(ip)
  if (version !== 6) return true

  const lower = ip.toLowerCase()
  // IPv4-mapped (::ffff:10.0.0.1) and the dotted form of it: judge the embedded v4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped?.[1]) return isPrivateV4(mapped[1])
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hexMapped?.[1] && hexMapped[2]) {
    const hi = Number.parseInt(hexMapped[1], 16)
    const lo = Number.parseInt(hexMapped[2], 16)
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  if (lower === '::' || lower === '::1') return true
  const first = Number.parseInt(lower.split(':')[0] || '0', 16)
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
}

function isPrivateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

/**
 * Refuse a URL whose host is, or resolves to, a private address. Returns the reason, or
 * undefined when every resolved address is public.
 *
 * This checks at resolution time; the fetch that follows resolves again, so a host that
 * answers public then private (DNS rebinding) can still slip through. It stops the plain
 * "fetch http://10.0.0.5/admin" and "fetch http://localhost:8080" cases, which are the ones
 * a visitor can type.
 */
export async function checkPublicUrl(url: string): Promise<string | undefined> {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return `Invalid URL: ${url}`
  }
  host = host.replace(/^\[|\]$/g, '')
  if (!host) return `Invalid URL: ${url}`

  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address)
    } catch {
      return `Could not resolve ${host}`
    }
  }
  const blocked = addresses.find(isPrivateAddress)
  return blocked
    ? `${host} resolves to a private address (${blocked}); refusing to fetch it`
    : undefined
}
