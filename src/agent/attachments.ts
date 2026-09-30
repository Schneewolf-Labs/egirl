import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join } from 'node:path'
import { log } from '../util/logger'

/**
 * Images the principal attaches are saved to disk so they can be handed on. The operator sees
 * them inline, but a code agent or consultant it delegates to only gets what it is given: a
 * screenshot that exists only as a data URL in the operator's context is invisible to Codex.
 * Saved files get a short handle (img1, img2, ...) numbered across the session, so the operator
 * can name them in a tool call, and a path that survives the context window clearing old images.
 */

export interface SavedImage {
  handle: string
  path: string
}

const DATA_URL_RE = /^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/s
const EXT: Record<string, string> = {
  png: 'png',
  jpeg: 'jpg',
  jpg: 'jpg',
  webp: 'webp',
  gif: 'gif',
}
export const HANDLE_RE = /^img(\d+)$/
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

export function attachmentsDir(workspaceDir: string, sessionId: string): string {
  return join(workspaceDir, 'attachments', sessionId.replace(/[^A-Za-z0-9._-]/g, '_'))
}

/** Next free handle number: session-wide, so img1 keeps meaning the same file for the session. */
function nextIndex(dir: string): number {
  if (!existsSync(dir)) return 1
  let max = 0
  for (const name of readdirSync(dir)) {
    const n = Number(name.match(/^img(\d+)-/)?.[1] ?? 0)
    if (n > max) max = n
  }
  return max + 1
}

/** Delete other sessions' attachment folders untouched for a week. */
function pruneOld(root: string, keep: string, now: number): void {
  if (!existsSync(root)) return
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    if (dir === keep) continue
    try {
      if (now - statSync(dir).mtimeMs > KEEP_MS) rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      log.warn('attachments', `Could not prune ${dir}:`, error)
    }
  }
}

export function saveImageAttachments(
  workspaceDir: string,
  sessionId: string,
  dataUrls: string[],
  now: number = Date.now(),
): SavedImage[] {
  const dir = attachmentsDir(workspaceDir, sessionId)
  pruneOld(join(workspaceDir, 'attachments'), dir, now)
  const saved: SavedImage[] = []
  let index = nextIndex(dir)
  for (const url of dataUrls) {
    const m = url.match(DATA_URL_RE)
    if (!m) {
      log.warn('attachments', 'Skipping an attachment that is not a base64 image data URL')
      continue
    }
    const bytes = Buffer.from(m[3] as string, 'base64')
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
    const handle = `img${index++}`
    const path = join(dir, `${handle}-${hash}.${EXT[m[2] as string]}`)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, bytes)
      saved.push({ handle, path })
    } catch (error) {
      // The operator still sees the image inline; it just cannot hand this one on.
      log.warn('attachments', `Could not save ${path}:`, error)
    }
  }
  return saved
}

/** The line appended to the user's message so the operator knows the handles and paths. */
export function attachmentNote(saved: SavedImage[]): string {
  if (saved.length === 0) return ''
  const list = saved.map((s) => `${s.handle} = ${s.path}`).join(', ')
  return `[Attached images, saved for handing on: ${list}]`
}

/**
 * Resolve what a tool call names (a handle like "img2", or a path) to image files on disk.
 * Unknown handles and non-image or missing paths come back in `missing` rather than throwing,
 * so the tool can say what it could not attach.
 */
export function resolveImageRefs(
  refs: string[],
  workspaceDir: string,
  sessionId: string | undefined,
): { paths: string[]; missing: string[] } {
  const paths: string[] = []
  const missing: string[] = []
  const dir = sessionId ? attachmentsDir(workspaceDir, sessionId) : undefined
  const files = dir && existsSync(dir) ? readdirSync(dir) : []
  for (const raw of refs) {
    const ref = raw.trim()
    const handle = ref.match(HANDLE_RE)
    if (handle) {
      const file = files.find((f) => f.startsWith(`img${handle[1]}-`))
      if (file && dir) paths.push(join(dir, file))
      else missing.push(ref)
      continue
    }
    const abs = isAbsolute(ref) ? ref : join(workspaceDir, ref)
    if (IMAGE_EXTS.has(extname(abs).toLowerCase()) && existsSync(abs)) paths.push(abs)
    else missing.push(ref)
  }
  return { paths: [...new Set(paths)], missing }
}
