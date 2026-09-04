import type { Database } from 'bun:sqlite'
import { openDatabase } from '../util/db'
import { log } from '../util/logger'

/**
 * Unified trace store — the forensic record of everything the agent actually did: every
 * inference turn (including thinking, which is otherwise streamed and dropped), every tool
 * call with full arguments and output, and every auxiliary model call (compaction summaries,
 * memory extraction) that previously left no trace at all.
 *
 * SQLite, one wide table, FTS over payloads. Verbosity is configurable and defaults to
 * verbose: on a single-user machine the disk is cheap and the post-mortem that reconstructs
 * why a run went sideways is not. Retention pruning keeps it bounded.
 *
 * Module-level singleton, same shape as the logger: session runs arrive through the journal
 * subscribed to the session bus (see journal.ts), aux callers tap it directly, and threading
 * a store through every constructor would couple half the codebase to tracing.
 * Uninitialized = every call is a no-op.
 */

export type TraceVerbosity = 'off' | 'metadata' | 'verbose'

export interface TraceEvent {
  session?: string
  /**
   * 'run_start'/'run_end' bracket one agent run; 'turn' = one inference; 'tool' = one tool
   * execution; 'aux' = side-model work.
   */
  kind: 'run_start' | 'run_end' | 'turn' | 'tool' | 'aux'
  /** Tool name, aux job name ('compaction', 'extraction'), or model for turns. */
  name?: string
  success?: boolean
  tokensIn?: number
  tokensOut?: number
  durationMs?: number
  /** Free-form body: {content, thinking} for turns, {args, output} for tools, etc. */
  payload?: Record<string, unknown>
}

/** Per-field character caps in verbose mode — a trace row must never be a context bomb. */
const VERBOSE_FIELD_CAP = 65536

function capPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === 'string' && v.length > VERBOSE_FIELD_CAP) {
      out[k] = `${v.slice(0, VERBOSE_FIELD_CAP)}…[truncated ${v.length - VERBOSE_FIELD_CAP} chars]`
    } else {
      out[k] = v
    }
  }
  return out
}

export interface TraceQuery {
  session?: string
  kind?: string
  /** FTS match over payloads. */
  q?: string
  limit?: number
}

export interface TraceRow {
  id: number
  ts: number
  session: string | null
  kind: string
  name: string | null
  success: number | null
  tokens_in: number | null
  tokens_out: number | null
  duration_ms: number | null
  payload: string | null
}

export class TraceStore {
  private db: Database
  private verbosity: TraceVerbosity
  private ftsAvailable = true

  constructor(path: string, verbosity: TraceVerbosity, retentionDays: number) {
    this.db = openDatabase(path)
    this.verbosity = verbosity
    this.db.run(`
      CREATE TABLE IF NOT EXISTS traces (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        session TEXT,
        kind TEXT NOT NULL,
        name TEXT,
        success INTEGER,
        tokens_in INTEGER,
        tokens_out INTEGER,
        duration_ms INTEGER,
        payload TEXT
      )
    `)
    this.db.run('CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(ts)')
    this.db.run('CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session, ts)')
    try {
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS traces_fts
        USING fts5(payload, content='traces', content_rowid='id')
      `)
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS traces_ai AFTER INSERT ON traces BEGIN
          INSERT INTO traces_fts(rowid, payload) VALUES (new.id, new.payload);
        END
      `)
      this.db.run(`
        CREATE TRIGGER IF NOT EXISTS traces_ad AFTER DELETE ON traces BEGIN
          INSERT INTO traces_fts(traces_fts, rowid, payload) VALUES ('delete', old.id, old.payload);
        END
      `)
    } catch (err) {
      this.ftsAvailable = false
      log.warn('traces', `FTS unavailable — trace search falls back to LIKE: ${err}`)
    }
    // Retention: prune on open, not on a timer — a long-running process reopens rarely, but
    // pruning per-write would tax the hot path for a bound nobody is watching in real time.
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    this.db.run('DELETE FROM traces WHERE ts < ?', [cutoff])
  }

  record(event: TraceEvent): void {
    if (this.verbosity === 'off') return
    try {
      const payload =
        this.verbosity === 'verbose' && event.payload
          ? JSON.stringify(capPayload(event.payload))
          : event.payload
            ? JSON.stringify(
                // metadata mode keeps shape, drops bodies: sizes tell the story cheaply.
                Object.fromEntries(
                  Object.entries(event.payload).map(([k, v]) => [
                    k,
                    typeof v === 'string' ? `[${v.length} chars]` : v,
                  ]),
                ),
              )
            : null
      this.db.run(
        `INSERT INTO traces (ts, session, kind, name, success, tokens_in, tokens_out, duration_ms, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Date.now(),
          event.session ?? null,
          event.kind,
          event.name ?? null,
          event.success === undefined ? null : event.success ? 1 : 0,
          event.tokensIn ?? null,
          event.tokensOut ?? null,
          event.durationMs ?? null,
          payload,
        ],
      )
    } catch (err) {
      // Telemetry must never break the work it is recording.
      log.warn('traces', `Trace write failed: ${err}`)
    }
  }

  query(q: TraceQuery): TraceRow[] {
    const limit = Math.min(q.limit ?? 50, 500)
    const where: string[] = []
    const params: unknown[] = []
    if (q.session) {
      where.push('session = ?')
      params.push(q.session)
    }
    if (q.kind) {
      where.push('kind = ?')
      params.push(q.kind)
    }
    if (q.q) {
      if (this.ftsAvailable) {
        // Quote terms so user text is data, not FTS grammar.
        const terms = q.q
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => `"${t.replace(/"/g, '""')}"`)
          .join(' ')
        where.push('id IN (SELECT rowid FROM traces_fts WHERE traces_fts MATCH ?)')
        params.push(terms)
      } else {
        where.push('payload LIKE ?')
        params.push(`%${q.q}%`)
      }
    }
    const sql = `SELECT * FROM traces ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC LIMIT ${limit}`
    return this.db.query(sql).all(...(params as never[])) as TraceRow[]
  }

  close(): void {
    this.db.close()
  }
}

let active: TraceStore | null = null

export function initTraces(path: string, verbosity: TraceVerbosity, retentionDays: number): void {
  if (verbosity === 'off') {
    active = null
    return
  }
  try {
    active = new TraceStore(path, verbosity, retentionDays)
    log.info('traces', `Trace store open at ${path} (${verbosity}, ${retentionDays}d retention)`)
  } catch (err) {
    log.warn('traces', `Trace store unavailable: ${err}`)
    active = null
  }
}

/** Record a trace event; a no-op when tracing is off or uninitialized. */
export function trace(event: TraceEvent): void {
  active?.record(event)
}

export function traceStore(): TraceStore | null {
  return active
}

/** Test hook: swap the active store. */
export function setTraceStore(store: TraceStore | null): void {
  active = store
}
