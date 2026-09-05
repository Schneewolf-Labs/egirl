import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Tool, ToolResult } from '../tools/types'
import { log } from '../util/logger'

/**
 * Skill mutation ledger — ported from hermes-agent's skill_ledger. Every write to a file
 * inside a skills directory appends a JSONL entry with before/after content hashes, and the
 * content itself is stored once per hash in a blob directory. That makes every skill edit —
 * by the user, by /learn, or (later) by an autonomous review pass — individually
 * rollbackable, which is what makes autonomous skill editing trustworthy at all.
 *
 * Explicitly telemetry, not a gate: a ledger failure never blocks the mutation it records.
 */

export interface LedgerEntry {
  ts: string
  actor: string
  tool: string
  /** Path as the tool received it, resolved absolute. */
  path: string
  /** sha256 of content before the mutation; null = file did not exist. */
  before: string | null
  /** sha256 after; null = file was deleted. */
  after: string | null
}

const LEDGER_FILE = 'ledger.jsonl'
const BLOBS_DIR = 'blobs'

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Store content once per hash; returns the hash. */
function putBlob(ledgerDir: string, content: string): string {
  const hash = sha256(content)
  const dir = join(ledgerDir, BLOBS_DIR)
  mkdirSync(dir, { recursive: true })
  const blobPath = join(dir, hash)
  if (!existsSync(blobPath)) writeFileSync(blobPath, content, 'utf8')
  return hash
}

export function recordMutation(
  ledgerDir: string,
  entry: Omit<LedgerEntry, 'ts' | 'before' | 'after'> & {
    beforeContent: string | null
    afterContent: string | null
  },
): void {
  try {
    mkdirSync(ledgerDir, { recursive: true })
    const row: LedgerEntry = {
      ts: new Date().toISOString(),
      actor: entry.actor,
      tool: entry.tool,
      path: entry.path,
      before: entry.beforeContent === null ? null : putBlob(ledgerDir, entry.beforeContent),
      after: entry.afterContent === null ? null : putBlob(ledgerDir, entry.afterContent),
    }
    appendFileSync(join(ledgerDir, LEDGER_FILE), `${JSON.stringify(row)}\n`, 'utf8')
  } catch (err) {
    // Telemetry, not a gate.
    log.warn('skills', `Skill ledger append failed (mutation NOT blocked): ${err}`)
  }
}

export function readLedger(ledgerDir: string): LedgerEntry[] {
  try {
    return readFileSync(join(ledgerDir, LEDGER_FILE), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEntry)
  } catch {
    return []
  }
}

/**
 * Restore the `before` state of one past mutation. Fail-closed: the needed blob must exist
 * and the target path must live under one of the allowed roots (a hand-edited ledger must
 * not become a write-anywhere primitive). The current state is recorded first as a safety
 * entry, so a rollback is itself rollbackable.
 */
export function rollbackEntry(
  ledgerDir: string,
  entry: LedgerEntry,
  allowedRoots: string[],
): { ok: boolean; error?: string } {
  const target = entry.path
  const contained = allowedRoots.some((root) => {
    const r = resolve(root)
    const rel = relative(r, resolve(target))
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
  })
  if (!contained) return { ok: false, error: `path ${target} is outside the allowed skill roots` }

  let restoreContent: string | null = null
  if (entry.before !== null) {
    const blobPath = join(ledgerDir, BLOBS_DIR, entry.before)
    if (!existsSync(blobPath)) return { ok: false, error: `missing blob ${entry.before}` }
    restoreContent = readFileSync(blobPath, 'utf8')
  }

  const current = existsSync(target) ? readFileSync(target, 'utf8') : null
  recordMutation(ledgerDir, {
    actor: 'rollback',
    tool: 'rollback',
    path: target,
    beforeContent: current,
    afterContent: restoreContent,
  })

  try {
    if (restoreContent === null) {
      // before = nonexistent; leave deletion to the caller rather than rm here.
      return {
        ok: false,
        error: 'entry predates file creation — delete the file manually if intended',
      }
    }
    writeFileSync(target, restoreContent, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/**
 * Wrap a file-mutating tool (path in `params.path`) so writes landing inside a skills
 * directory are recorded in the ledger. Non-skill paths pass through untouched.
 */
export function withSkillLedger(tool: Tool, skillsDirs: string[], ledgerDir: string): Tool {
  const roots = skillsDirs.map((d) => resolve(d))
  return {
    definition: tool.definition,
    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const rawPath = params.path
      let abs: string | undefined
      if (typeof rawPath === 'string' && rawPath.trim()) {
        abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)
      }
      const inSkills =
        abs !== undefined &&
        roots.some((r) => {
          const rel = relative(r, abs)
          return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
        })
      if (!inSkills || abs === undefined) return tool.execute(params, cwd)

      const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null
      const result = await tool.execute(params, cwd)
      if (result.success) {
        const after = existsSync(abs) ? readFileSync(abs, 'utf8') : null
        if (after !== before) {
          recordMutation(ledgerDir, {
            actor: 'agent',
            tool: tool.definition.name,
            path: abs,
            beforeContent: before,
            afterContent: after,
          })
        }
      }
      return result
    },
  }
}
