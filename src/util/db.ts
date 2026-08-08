import { Database } from 'bun:sqlite'

/**
 * Open a SQLite database with the pragmas every store here needs.
 *
 * egirl runs as more than one process more often than it looks: the CLI, a Discord channel, the
 * background task runner and any scripted `cli -m` invocation all open the same files under
 * ~/.egirl. Two of the five stores set WAL and none set a busy timeout, so a second process
 * hitting a locked database failed immediately rather than waiting a few milliseconds. The
 * visible symptom was memory quietly degrading:
 *
 *   ERROR [memory] Semantic search failed; falling back to keyword search only.
 *                  Memory recall is degraded. database is locked
 *
 * which is worse than an outright error — the agent keeps answering, with worse recall, and
 * nothing upstream knows the difference.
 *
 * - `journal_mode=WAL` lets readers and a writer coexist instead of excluding each other.
 * - `busy_timeout` makes a blocked statement wait and retry for up to five seconds instead of
 *   throwing SQLITE_BUSY on the spot. Five seconds is far longer than any statement here needs
 *   and still far shorter than a model call, so it is invisible in the normal case.
 * - `synchronous=NORMAL` is the standard companion to WAL: durable across process crashes,
 *   fsyncing only at checkpoints rather than every commit.
 *
 * Use this instead of `new Database(path)` so a new store cannot forget.
 */
export function openDatabase(path: string): Database {
  const db = new Database(path)
  db.run('PRAGMA journal_mode=WAL')
  db.run('PRAGMA busy_timeout=5000')
  db.run('PRAGMA synchronous=NORMAL')
  return db
}
