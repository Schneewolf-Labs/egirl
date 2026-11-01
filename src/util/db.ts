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
export function openDatabase(path: string, schema?: StoreSchema): Database {
  const db = new Database(path)
  // busy_timeout first: switching to WAL takes a lock, and set in the other order the very first
  // statement had no timeout. Two processes starting together (launchd restarting `serve` and
  // `api` at once) then lost the race on open, and the loser ran with that store disabled.
  db.run('PRAGMA busy_timeout=5000')
  db.run('PRAGMA journal_mode=WAL')
  db.run('PRAGMA synchronous=NORMAL')
  if (schema) assertSchemaSupported(db, schema)
  return db
}

/**
 * The schema a store's code writes. Each store owns one database file, so SQLite's
 * `user_version` is that store's schema version.
 *
 * Bump `version` when a change is more than an idempotent "add the column if it is missing":
 * a rename, a type change, a backfill. Read `schemaVersion(db)` before the store's setup to
 * decide what to migrate from; the store stamps the new version once setup succeeds.
 */
export interface StoreSchema {
  name: string
  version: number
}

/** The schema version stamped on a database; 0 for one written before versions existed. */
export function schemaVersion(db: Database): number {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null
  return row?.user_version ?? 0
}

/**
 * Refuse a database written by newer code. An older egirl (a rollback, a second checkout, a
 * stale process) would otherwise run its CREATE / ALTER statements against a schema it does not
 * know and write rows the newer code then misreads.
 */
function assertSchemaSupported(db: Database, schema: StoreSchema): void {
  const onDisk = schemaVersion(db)
  if (onDisk <= schema.version) return
  db.close()
  throw new Error(
    `${schema.name} database is schema v${onDisk}, but this egirl only knows v${schema.version}. ` +
      'It was written by a newer egirl: run `egirl update`, or restore a backup from before the upgrade.',
  )
}

/** Record that the store's setup (tables, migrations) has brought the file to `schema.version`. */
export function stampSchemaVersion(db: Database, schema: StoreSchema): void {
  if (schemaVersion(db) === schema.version) return
  // PRAGMA takes no bound parameters; version is an integer constant from code, never input.
  db.run(`PRAGMA user_version = ${Math.trunc(schema.version)}`)
}
