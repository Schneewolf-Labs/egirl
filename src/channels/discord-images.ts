import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g
/** Discord's upload limit without boosts is 10 MB; stay under it. */
const MAX_BYTES = 8 * 1024 * 1024
const MAX_FILES = 10
const FETCH_TIMEOUT_MS = 10_000
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])

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

const safeName = (name: string, fallback: string): string =>
  name.replace(/[^\w.-]/g, '_') || fallback

const urlFileName = (url: string): string =>
  safeName(new URL(url).pathname.split('/').pop() ?? '', 'image.png')

/**
 * Read an image she produced in her own workspace, named in the reply by a path rather than a
 * URL (`![chart](charts/run.png)`, an absolute path, or a `file://` URI). The reply is model
 * output, so the resolved real path must stay inside the workspace — a `../` climb or a symlink
 * that escapes is refused — and only known image extensions are read. This is how she attaches
 * her own screenshots, charts and diagrams without a public URL for them.
 */
async function readWorkspaceImage(
  target: string,
  workspaceDir: string,
): Promise<DiscordFile | undefined> {
  try {
    const raw = target.startsWith('file://') ? fileURLToPath(target) : target
    const base = await realpath(resolve(workspaceDir))
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
    if (!IMAGE_EXT.has(extname(abs).toLowerCase())) return undefined
    // Resolve symlinks before the containment check so a planted link cannot escape.
    const real = await realpath(abs)
    if (real !== base && !real.startsWith(base + sep)) {
      log.debug('discord', `local image outside workspace, refused: ${target}`)
      return undefined
    }
    const info = await stat(real)
    if (!info.isFile() || info.size > MAX_BYTES) return undefined
    return { attachment: await readFile(real), name: safeName(basename(real), 'image.png') }
  } catch (error) {
    log.debug('discord', `local image failed for ${target}:`, error)
    return undefined
  }
}

/**
 * Turn markdown images in a reply into Discord attachments. Two sources, both opt-in:
 *  - URLs under an `allow` prefix are fetched (a talent's pictures often live on a loopback image
 *    server Discord users cannot reach; the allow-list matters because the reply is model output
 *    and could otherwise be steered at internal addresses). Empty list turns this off.
 *  - Non-URL paths are read from `workspaceDir` when given — the files she makes herself — with
 *    the containment guard in readWorkspaceImage. Omitting workspaceDir turns this off.
 * Anything not attached stays in the text exactly as it was.
 */
export async function withImages(
  text: string,
  allow: string[],
  workspaceDir?: string,
): Promise<DiscordPayload> {
  const files: DiscordFile[] = []
  if (allow.length === 0 && !workspaceDir) return { content: text, files }
  let content = text
  let changed = false
  for (const [md, alt, target] of text.matchAll(IMAGE_RE)) {
    if (files.length >= MAX_FILES || !target) continue
    let file: DiscordFile | undefined
    if (/^https?:\/\//i.test(target)) {
      if (!allow.some((p) => target.startsWith(p))) continue
      const attachment = await fetchImage(target)
      if (attachment) file = { attachment, name: urlFileName(target) }
    } else if (workspaceDir) {
      file = await readWorkspaceImage(target, workspaceDir)
    }
    if (!file) continue
    if (alt) file.description = alt
    files.push(file)
    content = content.replace(md, '')
    changed = true
  }
  return { content: changed ? content.replace(/\n{3,}/g, '\n\n').trim() : text, files }
}
