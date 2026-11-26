/**
 * heartbeat-noop-no-memories: a heartbeat run that finds nothing to do must leave the memory
 * store as it found it.
 *
 * Production symptom: HEARTBEAT.md held one recurring item whose own text says when it is a
 * no-op ("If HEAD is still 690558d, nothing new: reply in one line and stop"). Every run was a
 * no-op, and every run still wrote 1-3 near-duplicate "User maintains a HEARTBEAT.md..."
 * memories. Those come from the task runner's post-run extraction (auto/task/<name>/... and
 * lesson/task/<name>/...), which runs after every task with memory on, whatever the run found.
 *
 * Setup makes the item's premise true: the workspace is a git repo whose HEAD is the commit
 * the item names, committed six hours ago, with a clean tree. The heartbeat task is seeded
 * exactly as seedHeartbeatTask does it. The API process doesn't seed it, because it runs no
 * schedule. Its next run is parked a year out and the runner ticks hourly, so the only runs
 * are the two POST /tasks/:id/run calls. Each is followed by a settle, so the run's
 * fire-and-forget extraction has landed before anything is counted.
 *
 * On the stub operator, extraction parses "ok." and writes nothing, so an unchanged count
 * proves nothing there: the memory checks report not-meaningful. A count that changes is
 * still a real failure, stub or not.
 */

import { Database } from 'bun:sqlite'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTaskStore, HEARTBEAT_TASK_NAME } from '../../src/tasks'
import { bootstrapWorkspace } from '../../src/workspace/bootstrap'
import { oneLine } from './checks'
import {
  type CheckContext,
  type CheckResult,
  fail,
  type InstanceScenario,
  notMeaningful,
  pass,
  type StepContext,
} from './types'

const RUNS = 2
const SKIPPED = 'No unchecked items in HEARTBEAT.md'

interface MemoryRow {
  key: string
  value: string
}

function readMemories(workspace: string): MemoryRow[] {
  const db = new Database(join(workspace, 'memory.db'), { readonly: true })
  try {
    return db.query('SELECT key, value FROM memories ORDER BY id').all() as MemoryRow[]
  } finally {
    db.close()
  }
}

function git(args: string[], cwd: string, home: string, date?: string): string {
  const r = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'scenario',
      GIT_AUTHOR_EMAIL: 'scenario@localhost',
      GIT_COMMITTER_NAME: 'scenario',
      GIT_COMMITTER_EMAIL: 'scenario@localhost',
      ...(date && { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
    },
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

function heartbeatItem(sha: string): string {
  return `- [ ] Summarize recent git activity if idle for 4+ hours — last summarized through \`${sha}\`. If HEAD is still \`${sha}\`, nothing new: reply in one line and stop.`
}

async function runHeartbeat(ctx: StepContext): Promise<string> {
  const res = await fetch(`${ctx.url}/tasks/${ctx.state.taskId}/run`, {
    method: 'POST',
    signal: AbortSignal.timeout(ctx.timeoutMs),
  })
  const body = (await res.json()) as { status?: string; result?: string; error?: string }
  await ctx.settle()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error ?? JSON.stringify(body)}`)
  return `[${body.status}] ${body.result ?? body.error ?? ''}`
}

/** Fail on a change whatever the operator; an unchanged store only means something live. */
function memoryVerdict(
  ctx: CheckContext,
  name: string,
  changed: boolean,
  evidence: string,
): CheckResult {
  if (changed) return fail(name, evidence)
  if (ctx.operator === 'stub') {
    return notMeaningful(
      name,
      `not meaningful on stub (extraction can't write from "ok."): ${evidence}`,
    )
  }
  return pass(name, evidence)
}

function describe(rows: MemoryRow[]): string {
  return rows.map((r) => `${r.key} = "${oneLine(r.value, 90)}"`).join(' | ')
}

export const heartbeatNoopNoMemories: InstanceScenario = {
  name: 'heartbeat-noop-no-memories',
  description: 'a no-op heartbeat run writes no memories',

  config: ({ embeddings }) => ({
    memory: { proactive_retrieval: true, auto_extract: true },
    local: {
      embeddings: {
        provider: 'llamacpp',
        endpoint: embeddings.endpoint,
        model: 'scenario-embed',
        dimensions: embeddings.dims,
        multimodal: false,
      },
    },
    // Hourly ticks and a parked next run: the runner never starts a run on its own.
    tasks: {
      enabled: true,
      tick_interval_ms: 3_600_000,
      discovery_enabled: false,
      heartbeat: { enabled: true },
    },
    tools: { tasks: true },
  }),

  async setup({ workspace, home, state }) {
    // Persona files first, so egirl's own bootstrap at boot finds them and the tree stays clean.
    await bootstrapWorkspace(workspace)
    git(['init', '-q', '-b', 'main'], workspace, home)
    // egirl's runtime state is not part of the workspace's history.
    writeFileSync(
      join(workspace, '.git', 'info', 'exclude'),
      ['HEARTBEAT.md', '*.db', '*.db-*', 'logs/', 'sessions/', 'audit.log', ''].join('\n'),
    )
    git(['add', '-A'], workspace, home)
    const sixHoursAgo = new Date(Date.now() - 6 * 3_600_000).toISOString()
    git(['commit', '-q', '-m', 'Workspace snapshot'], workspace, home, sixHoursAgo)
    const sha = git(['rev-parse', '--short=7', 'HEAD'], workspace, home)
    writeFileSync(join(workspace, 'HEARTBEAT.md'), `# Heartbeat\n\n${heartbeatItem(sha)}\n`)
    state.sha = sha

    // As seedHeartbeatTask creates it (src/tasks/heartbeat.ts).
    const store = createTaskStore(join(workspace, 'tasks.db'))
    try {
      const task = store.create({
        name: HEARTBEAT_TASK_NAME,
        description:
          'Periodic check of HEARTBEAT.md items — only runs LLM when there are unchecked items',
        kind: 'scheduled',
        prompt: '',
        cronExpression: '*/30 * * * *',
        notify: 'on_change',
        channel: 'api',
        channelTarget: 'api:default',
        createdBy: 'system',
      })
      store.update(task.id, { nextRunAt: Date.now() + 365 * 86_400_000 })
      state.taskId = task.id
    } finally {
      store.close()
    }
  },

  turns: [
    {
      action: 'snapshot memory store',
      run: async (ctx) => {
        // After boot, not after setup: boot indexes the daily log into memory itself.
        const rows = readMemories(ctx.workspace)
        ctx.state.before = rows
        return `${rows.length} memories`
      },
    },
    ...Array.from({ length: RUNS }, (_, i) => ({
      action: `heartbeat run ${i + 1}`,
      run: runHeartbeat,
    })),
  ],

  checks: (ctx) => {
    const db = new Database(join(ctx.workspace, 'tasks.db'), { readonly: true })
    let runs: Array<{ status: string; result: string | null; error: string | null }>
    try {
      runs = db
        .query('SELECT status, result, error FROM task_runs WHERE task_id = ? ORDER BY started_at')
        .all(ctx.state.taskId as string) as typeof runs
    } finally {
      db.close()
    }
    const ranLines = runs.map((r, i) => {
      const text = r.result ?? r.error ?? ''
      const reached = text.startsWith(SKIPPED) ? 'pre-check skipped, model not called' : 'model ran'
      return `#${i + 1} ${r.status} (${reached}): "${oneLine(text, 80)}"`
    })
    const ran =
      runs.length === RUNS && runs.every((r) => r.status === 'success')
        ? pass('heartbeat ran each time', ranLines.join(' | '))
        : fail(
            'heartbeat ran each time',
            `${runs.length}/${RUNS} runs recorded: ${ranLines.join(' | ') || 'none'}`,
          )

    const before = (ctx.state.before as MemoryRow[] | undefined) ?? []
    const after = readMemories(ctx.workspace)
    const known = new Set(before.map((r) => r.key))
    const added = after.filter((r) => !known.has(r.key))
    const countEvidence = `before=${before.length} after=${after.length}${added.length ? `; new: ${describe(added)}` : ''}`
    const heartbeatRows = added.filter((r) => r.key.startsWith('auto/task/heartbeat'))
    const keyEvidence = heartbeatRows.length
      ? `${heartbeatRows.length} new: ${describe(heartbeatRows)}`
      : 'no auto/task/heartbeat* rows added'

    return [
      ran,
      memoryVerdict(ctx, 'memory count unchanged', after.length !== before.length, countEvidence),
      memoryVerdict(ctx, 'no new auto/task/heartbeat rows', heartbeatRows.length > 0, keyEvidence),
    ]
  },
}
