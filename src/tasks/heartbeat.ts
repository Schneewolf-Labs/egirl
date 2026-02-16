import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { log } from '../util/logger'
import type { TaskRunner } from './runner'
import type { TaskStore } from './store'
import type { TasksConfig } from './types'

/** Regex matching unchecked markdown checkboxes: `- [ ] some text` */
const UNCHECKED_RE = /^[ \t]*-\s*\[\s\]\s+(.+)$/gm

/** Name used for the built-in heartbeat task */
export const HEARTBEAT_TASK_NAME = 'heartbeat'

export interface HeartbeatConfig {
  /** Enable the heartbeat system. Default: true (when tasks are enabled) */
  enabled: boolean
  /** Cron expression or time-of-day for heartbeat schedule. Default: every 30 min */
  schedule: string
  /** Business hours constraint. Default: undefined (always) */
  businessHours?: string
}

export const HEARTBEAT_DEFAULTS: HeartbeatConfig = {
  enabled: true,
  schedule: '*/30 * * * *',
}

/** Parse HEARTBEAT.md and return unchecked items. Returns empty array if file missing or no items. */
export async function parseHeartbeatFile(workspacePath: string): Promise<string[]> {
  const filePath = join(workspacePath, 'HEARTBEAT.md')
  let content: string

  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return []
  }

  const items: string[] = []
  let match: RegExpExecArray | null
  // Reset regex state for each call
  UNCHECKED_RE.lastIndex = 0
  while ((match = UNCHECKED_RE.exec(content)) !== null) {
    const item = match[1]?.trim()
    if (item) items.push(item)
  }

  return items
}

/** Check off a completed item in HEARTBEAT.md by replacing `- [ ]` with `- [x]` */
export async function checkOffItem(workspacePath: string, itemText: string): Promise<boolean> {
  const filePath = join(workspacePath, 'HEARTBEAT.md')
  let content: string

  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return false
  }

  // Escape special regex chars in the item text for safe matching
  const escaped = itemText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^([ \\t]*-\\s*)\\[\\s\\](\\s+${escaped})$`, 'm')
  const updated = content.replace(pattern, '$1[x]$2')

  if (updated === content) return false

  await writeFile(filePath, updated, 'utf-8')
  return true
}

/**
 * The heartbeat prompt. Receives the unchecked items as context.
 * The agent gets the list of items and workspace context via the task runner's
 * normal memory/standup injection.
 */
function buildHeartbeatPrompt(items: string[]): string {
  const itemList = items.map((item) => `- ${item}`).join('\n')

  return `You are running a heartbeat check. The following items from HEARTBEAT.md need attention:

${itemList}

For each item:
1. Investigate using your available tools (execute_command, read_file, memory_search, etc.)
2. Report findings concisely
3. If an item is resolved or no longer relevant, use write_file to check it off in HEARTBEAT.md (change "- [ ]" to "- [x]")

Be brief. Only report actionable findings. If an item needs no action right now, say so in one line.`
}

export interface HeartbeatSeedDeps {
  store: TaskStore
  runner: TaskRunner
  tasksConfig: TasksConfig
  heartbeatConfig: HeartbeatConfig
  workspacePath: string
  channel: string
  channelTarget: string
}

/**
 * Ensure the built-in heartbeat task exists and is active.
 * Called once at startup. If the user deleted or paused it, we respect that.
 */
export function seedHeartbeatTask(deps: HeartbeatSeedDeps): void {
  if (!deps.heartbeatConfig.enabled) return

  // Check if heartbeat task already exists (any status)
  const existing = deps.store.list().find((t) => t.name === HEARTBEAT_TASK_NAME)
  if (existing) {
    log.debug('heartbeat', `Heartbeat task exists (${existing.id}, status=${existing.status})`)
    return
  }

  const task = deps.store.create({
    name: HEARTBEAT_TASK_NAME,
    description:
      'Periodic check of HEARTBEAT.md items — only runs LLM when there are unchecked items',
    kind: 'scheduled',
    prompt: '', // Replaced at execution time by the pre-checker
    cronExpression: deps.heartbeatConfig.schedule,
    businessHours: deps.heartbeatConfig.businessHours,
    notify: 'on_change',
    channel: deps.channel,
    channelTarget: deps.channelTarget,
    createdBy: 'system',
  })

  deps.runner.activateTask(task.id)
  log.info(
    'heartbeat',
    `Seeded heartbeat task (${task.id}, schedule=${deps.heartbeatConfig.schedule})`,
  )
}

/**
 * Pre-check hook for the heartbeat task. Called by the task runner before
 * executing the prompt. Returns undefined to skip execution (no unchecked items),
 * or a prompt string to run.
 *
 * This is the key optimization over OpenClaw: deterministic file parsing
 * instead of burning LLM tokens to decide "nothing to do."
 */
export async function heartbeatPreCheck(workspacePath: string): Promise<string | undefined> {
  const items = await parseHeartbeatFile(workspacePath)

  if (items.length === 0) {
    log.debug('heartbeat', 'No unchecked items in HEARTBEAT.md — skipping')
    return undefined
  }

  log.info('heartbeat', `${items.length} unchecked item(s) in HEARTBEAT.md`)
  return buildHeartbeatPrompt(items)
}
