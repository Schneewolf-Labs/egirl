import { Database } from 'bun:sqlite'
import { log } from '../util/logger'
import type { TaskErrorKind } from './error-classify'
import type {
  NewTask,
  RunResult,
  Task,
  TaskFilter,
  TaskProposal,
  TaskRun,
  TaskStatus,
  TaskTransition,
} from './types'

function generateId(): string {
  return crypto.randomUUID().slice(0, 8)
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    kind: row.kind as Task['kind'],
    status: row.status as Task['status'],
    prompt: row.prompt as string,
    workflow: row.workflow ? JSON.parse(row.workflow as string) : undefined,
    memoryContext: row.memory_context ? JSON.parse(row.memory_context as string) : undefined,
    memoryCategory: (row.memory_category as string) ?? undefined,
    intervalMs: (row.interval_ms as number) ?? undefined,
    cronExpression: (row.cron_expression as string) ?? undefined,
    businessHours: (row.business_hours as string) ?? undefined,
    dependsOn: (row.depends_on as string) ?? undefined,
    eventSource: (row.event_source as Task['eventSource']) ?? undefined,
    eventConfig: row.event_config ? JSON.parse(row.event_config as string) : undefined,
    triggerMode: ((row.trigger_mode as string) ?? 'execute') as Task['triggerMode'],
    persistConversation: (row.persist_conversation as number) === 1,
    nextRunAt: (row.next_run_at as number) ?? undefined,
    lastRunAt: (row.last_run_at as number) ?? undefined,
    runCount: (row.run_count as number) ?? 0,
    maxRuns: (row.max_runs as number) ?? undefined,
    consecutiveFailures: (row.consecutive_failures as number) ?? 0,
    lastErrorKind: (row.last_error_kind as TaskErrorKind) ?? undefined,
    notify: (row.notify as Task['notify']) ?? 'on_change',
    lastResultHash: (row.last_result_hash as string) ?? undefined,
    channel: row.channel as string,
    channelTarget: row.channel_target as string,
    createdBy: row.created_by as string,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }
}

function rowToRun(row: Record<string, unknown>): TaskRun {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    startedAt: row.started_at as number,
    completedAt: (row.completed_at as number) ?? undefined,
    status: row.status as TaskRun['status'],
    result: (row.result as string) ?? undefined,
    error: (row.error as string) ?? undefined,
    errorKind: (row.error_kind as TaskErrorKind) ?? undefined,
    triggerInfo: row.trigger_info ? JSON.parse(row.trigger_info as string) : undefined,
    tokensUsed: (row.tokens_used as number) ?? 0,
  }
}

function rowToProposal(row: Record<string, unknown>): TaskProposal {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    messageId: (row.message_id as string) ?? undefined,
    channel: row.channel as string,
    channelTarget: row.channel_target as string,
    status: row.status as TaskProposal['status'],
    rejectedAt: (row.rejected_at as number) ?? undefined,
    createdAt: row.created_at as number,
  }
}

export class TaskStore {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.run('PRAGMA journal_mode=WAL')
    this.initialize()
  }

  private initialize(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        workflow TEXT,
        memory_context TEXT,
        memory_category TEXT,
        interval_ms INTEGER,
        cron_expression TEXT,
        business_hours TEXT,
        depends_on TEXT,
        event_source TEXT,
        event_config TEXT,
        persist_conversation INTEGER DEFAULT 0,
        next_run_at INTEGER,
        last_run_at INTEGER,
        run_count INTEGER DEFAULT 0,
        max_runs INTEGER,
        consecutive_failures INTEGER DEFAULT 0,
        last_error_kind TEXT,
        notify TEXT DEFAULT 'on_change',
        last_result_hash TEXT,
        channel TEXT NOT NULL,
        channel_target TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        error_kind TEXT,
        trigger_info TEXT,
        tokens_used INTEGER DEFAULT 0,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_proposals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        message_id TEXT,
        channel TEXT NOT NULL,
        channel_target TEXT NOT NULL,
        status TEXT NOT NULL,
        rejected_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_transitions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        reason TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )
    `)

    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_transitions_task ON task_transitions(task_id, timestamp)',
    )
    this.db.run('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)')
    this.db.run('CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run_at)')
    this.db.run('CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at)')
    this.db.run('CREATE INDEX IF NOT EXISTS idx_proposals_message ON task_proposals(message_id)')
    this.db.run('CREATE INDEX IF NOT EXISTS idx_tasks_depends ON tasks(depends_on)')

    // Enable foreign keys
    this.db.run('PRAGMA foreign_keys = ON')

    // Migrate existing databases: add new columns if missing
    this.migrate()

    log.debug('tasks', 'Task store initialized')
  }

  private migrate(): void {
    const columns = this.db.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    const columnNames = new Set(columns.map((c) => c.name))

    const migrations: Array<[string, string]> = [
      ['cron_expression', 'ALTER TABLE tasks ADD COLUMN cron_expression TEXT'],
      ['business_hours', 'ALTER TABLE tasks ADD COLUMN business_hours TEXT'],
      ['depends_on', 'ALTER TABLE tasks ADD COLUMN depends_on TEXT'],
      ['last_error_kind', 'ALTER TABLE tasks ADD COLUMN last_error_kind TEXT'],
      ['trigger_mode', "ALTER TABLE tasks ADD COLUMN trigger_mode TEXT DEFAULT 'execute'"],
      [
        'persist_conversation',
        'ALTER TABLE tasks ADD COLUMN persist_conversation INTEGER DEFAULT 0',
      ],
    ]

    for (const [col, sql] of migrations) {
      if (!columnNames.has(col)) {
        this.db.run(sql)
        log.debug('tasks', `Migrated: added column ${col}`)
      }
    }

    // Migrate task_runs table
    const runColumns = this.db.query('PRAGMA table_info(task_runs)').all() as Array<{
      name: string
    }>
    const runColumnNames = new Set(runColumns.map((c) => c.name))
    if (!runColumnNames.has('error_kind')) {
      this.db.run('ALTER TABLE task_runs ADD COLUMN error_kind TEXT')
      log.debug('tasks', 'Migrated: added column error_kind to task_runs')
    }
  }

  create(input: NewTask): Task {
    const now = Date.now()
    const id = generateId()
    const status: TaskStatus = input.createdBy === 'agent' ? 'proposed' : 'active'

    let nextRunAt: number | undefined
    if (
      input.kind === 'scheduled' &&
      (input.intervalMs || input.cronExpression) &&
      status === 'active'
    ) {
      // nextRunAt is calculated by the runner after creation when it calls activateTask
      nextRunAt = input.intervalMs ? now + input.intervalMs : now
    }
    if (input.kind === 'oneshot' && status === 'active') {
      nextRunAt = now
    }

    this.db.run(
      `
      INSERT INTO tasks (
        id, name, description, kind, status, prompt, workflow,
        memory_context, memory_category, interval_ms,
        cron_expression, business_hours, depends_on,
        event_source, event_config, trigger_mode, persist_conversation,
        next_run_at, max_runs, notify, channel, channel_target,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        id,
        input.name,
        input.description,
        input.kind,
        status,
        input.prompt,
        input.workflow ? JSON.stringify(input.workflow) : null,
        input.memoryContext ? JSON.stringify(input.memoryContext) : null,
        input.memoryCategory ?? null,
        input.intervalMs ?? null,
        input.cronExpression ?? null,
        input.businessHours ?? null,
        input.dependsOn ?? null,
        input.eventSource ?? null,
        input.eventConfig ? JSON.stringify(input.eventConfig) : null,
        input.triggerMode ?? 'execute',
        input.persistConversation ? 1 : 0,
        nextRunAt ?? null,
        input.maxRuns ?? null,
        input.notify ?? 'on_change',
        input.channel,
        input.channelTarget,
        input.createdBy,
        now,
        now,
      ],
    )

    // Record initial transition
    this.recordTransition(id, 'new', status)

    const created = this.get(id)
    if (!created) throw new Error(`Failed to create task ${id}`)
    return created
  }

  get(id: string): Task | undefined {
    const row = this.db.query('SELECT * FROM tasks WHERE id = ?').get(id) as Record<
      string,
      unknown
    > | null
    return row ? rowToTask(row) : undefined
  }

  update(id: string, changes: Partial<Task>, reason?: string): void {
    // Record transition if status is changing
    if (changes.status) {
      const current = this.get(id)
      if (current && current.status !== changes.status) {
        this.recordTransition(id, current.status, changes.status, reason)
      }
    }

    const sets: string[] = []
    const values: unknown[] = []

    const fieldMap: Record<string, string> = {
      name: 'name',
      description: 'description',
      kind: 'kind',
      status: 'status',
      prompt: 'prompt',
      intervalMs: 'interval_ms',
      cronExpression: 'cron_expression',
      businessHours: 'business_hours',
      dependsOn: 'depends_on',
      triggerMode: 'trigger_mode',
      nextRunAt: 'next_run_at',
      lastRunAt: 'last_run_at',
      runCount: 'run_count',
      maxRuns: 'max_runs',
      consecutiveFailures: 'consecutive_failures',
      lastErrorKind: 'last_error_kind',
      notify: 'notify',
      lastResultHash: 'last_result_hash',
      memoryCategory: 'memory_category',
    }

    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in changes) {
        sets.push(`${col} = ?`)
        values.push((changes as Record<string, unknown>)[key] ?? null)
      }
    }

    // JSON fields
    if ('workflow' in changes) {
      sets.push('workflow = ?')
      values.push(changes.workflow ? JSON.stringify(changes.workflow) : null)
    }
    if ('memoryContext' in changes) {
      sets.push('memory_context = ?')
      values.push(changes.memoryContext ? JSON.stringify(changes.memoryContext) : null)
    }
    if ('eventConfig' in changes) {
      sets.push('event_config = ?')
      values.push(changes.eventConfig ? JSON.stringify(changes.eventConfig) : null)
    }
    // Boolean field — handle separately to avoid false ?? null → null
    if ('persistConversation' in changes) {
      sets.push('persist_conversation = ?')
      values.push(changes.persistConversation ? 1 : 0)
    }

    if (sets.length === 0) return

    sets.push('updated_at = ?')
    values.push(Date.now())
    values.push(id)

    this.db.run(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`,
      values as (string | number | null)[],
    )
  }

  delete(id: string): boolean {
    const result = this.db.run('DELETE FROM tasks WHERE id = ?', [id])
    return result.changes > 0
  }

  list(filter?: TaskFilter): Task[] {
    let sql = 'SELECT * FROM tasks'
    const conditions: string[] = []
    const values: unknown[] = []

    if (filter?.status) {
      conditions.push('status = ?')
      values.push(filter.status)
    }
    if (filter?.kind) {
      conditions.push('kind = ?')
      values.push(filter.kind)
    }
    if (filter?.channel) {
      conditions.push('channel = ?')
      values.push(filter.channel)
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`
    }
    sql += ' ORDER BY created_at DESC'

    const rows = this.db.query(sql).all(...(values as (string | number | null)[])) as Array<
      Record<string, unknown>
    >
    return rows.map(rowToTask)
  }

  activeCount(): number {
    const row = this.db
      .query("SELECT COUNT(*) as count FROM tasks WHERE status = 'active'")
      .get() as { count: number }
    return row.count
  }

  getDueTasks(now: number): Task[] {
    const rows = this.db
      .query(`
      SELECT * FROM tasks
      WHERE status = 'active'
        AND kind IN ('scheduled', 'oneshot')
        AND next_run_at IS NOT NULL
        AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `)
      .all(now) as Array<Record<string, unknown>>
    return rows.map(rowToTask)
  }

  getEventTasks(): Task[] {
    const rows = this.db
      .query(`
      SELECT * FROM tasks
      WHERE status = 'active' AND kind = 'event'
    `)
      .all() as Array<Record<string, unknown>>
    return rows.map(rowToTask)
  }

  /** Get tasks that depend on a given task ID */
  getDependents(taskId: string): Task[] {
    const rows = this.db
      .query(`
      SELECT * FROM tasks
      WHERE depends_on = ? AND status = 'active'
    `)
      .all(taskId) as Array<Record<string, unknown>>
    return rows.map(rowToTask)
  }

  // --- Run tracking ---

  createRun(taskId: string, triggerInfo?: unknown): TaskRun {
    const id = generateId()
    const now = Date.now()

    this.db.run(
      `
      INSERT INTO task_runs (id, task_id, started_at, status, trigger_info)
      VALUES (?, ?, ?, 'running', ?)
    `,
      [id, taskId, now, triggerInfo ? JSON.stringify(triggerInfo) : null],
    )

    return {
      id,
      taskId,
      startedAt: now,
      completedAt: undefined,
      status: 'running',
      result: undefined,
      error: undefined,
      errorKind: undefined,
      triggerInfo,
      tokensUsed: 0,
    }
  }

  completeRun(runId: string, result: RunResult): void {
    this.db.run(
      `
      UPDATE task_runs
      SET status = ?, result = ?, error = ?, error_kind = ?, tokens_used = ?, completed_at = ?
      WHERE id = ?
    `,
      [
        result.status,
        result.result ?? null,
        result.error ?? null,
        result.errorKind ?? null,
        result.tokensUsed ?? 0,
        Date.now(),
        runId,
      ],
    )
  }

  getRecentRuns(taskId: string, limit = 10): TaskRun[] {
    const rows = this.db
      .query(`
      SELECT * FROM task_runs
      WHERE task_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `)
      .all(taskId, limit) as Array<Record<string, unknown>>
    return rows.map(rowToRun)
  }

  // --- Transition ledger ---

  recordTransition(taskId: string, fromStatus: string, toStatus: string, reason?: string): void {
    const id = generateId()
    this.db.run(
      `INSERT INTO task_transitions (id, task_id, from_status, to_status, reason, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, taskId, fromStatus, toStatus, reason ?? null, Date.now()],
    )
  }

  getTransitions(taskId: string, limit = 50): TaskTransition[] {
    const rows = this.db
      .query(`
      SELECT id, task_id, from_status, to_status, reason, timestamp
      FROM task_transitions
      WHERE task_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `)
      .all(taskId, limit) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: row.id as string,
      taskId: row.task_id as string,
      fromStatus: row.from_status as string,
      toStatus: row.to_status as string,
      reason: (row.reason as string) ?? undefined,
      timestamp: row.timestamp as number,
    })) as TaskTransition[]
  }

  /** Get the most recent successful run for a task */
  getLastSuccessfulRun(taskId: string): TaskRun | undefined {
    const row = this.db
      .query(`
      SELECT * FROM task_runs
      WHERE task_id = ? AND status = 'success'
      ORDER BY started_at DESC
      LIMIT 1
    `)
      .get(taskId) as Record<string, unknown> | null
    return row ? rowToRun(row) : undefined
  }

  // --- Proposals ---

  createProposal(
    taskId: string,
    channel: string,
    target: string,
    messageId?: string,
  ): TaskProposal {
    const id = generateId()
    const now = Date.now()

    this.db.run(
      `
      INSERT INTO task_proposals (id, task_id, message_id, channel, channel_target, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `,
      [id, taskId, messageId ?? null, channel, target, now],
    )

    return {
      id,
      taskId,
      messageId,
      channel,
      channelTarget: target,
      status: 'pending',
      rejectedAt: undefined,
      createdAt: now,
    }
  }

  getProposalByMessage(messageId: string): TaskProposal | undefined {
    const row = this.db
      .query('SELECT * FROM task_proposals WHERE message_id = ?')
      .get(messageId) as Record<string, unknown> | null
    return row ? rowToProposal(row) : undefined
  }

  updateProposal(id: string, changes: { status: string; rejectedAt?: number }): void {
    this.db.run('UPDATE task_proposals SET status = ?, rejected_at = ? WHERE id = ?', [
      changes.status,
      changes.rejectedAt ?? null,
      id,
    ])
  }

  wasRecentlyRejected(name: string, withinMs: number): boolean {
    const cutoff = Date.now() - withinMs
    const row = this.db
      .query(`
      SELECT 1 FROM task_proposals p
      JOIN tasks t ON p.task_id = t.id
      WHERE t.name = ? AND p.status = 'rejected' AND p.rejected_at > ?
      LIMIT 1
    `)
      .get(name, cutoff)
    return row !== null
  }

  // --- Lifecycle ---

  compact(maxAgeDays: number): {
    runsDeleted: number
    proposalsDeleted: number
    transitionsDeleted: number
  } {
    const cutoff = Date.now() - maxAgeDays * 86_400_000
    let runsDeleted = 0
    let proposalsDeleted = 0
    let transitionsDeleted = 0

    this.db.transaction(() => {
      const runResult = this.db.run(
        'DELETE FROM task_runs WHERE completed_at IS NOT NULL AND completed_at < ?',
        [cutoff],
      )
      runsDeleted = runResult.changes

      const propResult = this.db.run('DELETE FROM task_proposals WHERE created_at < ?', [cutoff])
      proposalsDeleted = propResult.changes

      const transResult = this.db.run('DELETE FROM task_transitions WHERE timestamp < ?', [cutoff])
      transitionsDeleted = transResult.changes
    })()

    if (runsDeleted > 0 || proposalsDeleted > 0 || transitionsDeleted > 0) {
      log.info(
        'tasks',
        `Compacted: ${runsDeleted} runs, ${proposalsDeleted} proposals, ${transitionsDeleted} transitions removed`,
      )
    }

    return { runsDeleted, proposalsDeleted, transitionsDeleted }
  }

  close(): void {
    this.db.close()
  }
}

export function createTaskStore(dbPath: string): TaskStore {
  return new TaskStore(dbPath)
}
