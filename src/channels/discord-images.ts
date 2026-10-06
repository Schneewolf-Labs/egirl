import { log } from '../util/logger'

/** A file in the shape discord.js takes in `files` on reply/send/editReply/followUp. */
export interface DiscordFile {
  attachment: Buffer
  name: string
  description?: string
}

export interface DiscordPayload {
  content: string
  files: DiscordFile[]
}

const IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g
/** Discord's upload limit without boosts is 10 MB; stay under it. */
const MAX_BYTES = 8 * 1024 * 1024
const MAX_FILES = 10
const FETCH_TIMEOUT_MS = 10_000

async function fetchImage(url: string): Promise<Buffer | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return undefined
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.byteLength <= MAX_BYTES ? buf : undefined
  } catch (error) {
    log.debug('discord', `image fetch failed for ${url}:`, error)
    return undefined
  }
}

const fileName = (url: string): string =>
  (new URL(url).pathname.split('/').pop() ?? '').replace(/[^\w.-]/g, '_') || 'image.png'

/**
 * Turn markdown images in a reply into Discord attachments: a talent's pictures often live on a
 * loopback image server Discord users cannot reach. Only URLs under an `allow` prefix are
 * fetched (the reply is model output, and viewers can steer it toward internal addresses), so an
 * empty list turns this off. Anything not fetched stays in the text as it was.
 */
export async function withImages(text: string, allow: string[]): Promise<DiscordPayload> {
  const files: DiscordFile[] = []
  if (allow.length === 0) return { content: text, files }
  let content = text
  for (const [md, alt, url] of text.matchAll(IMAGE_RE)) {
    if (files.length >= MAX_FILES || !url || !allow.some((p) => url.startsWith(p))) continue
    const attachment = await fetchImage(url)
    if (!attachment) continue
    files.push({ attachment, name: fileName(url), ...(alt ? { description: alt } : {}) })
    content = content.replace(md, '')
  }
  return { content: files.length ? content.replace(/\n{3,}/g, '\n\n').trim() : text, files }
}
