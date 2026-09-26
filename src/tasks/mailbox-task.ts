import { log } from '../util/logger'
import type { TaskRunner } from './runner'
import type { TaskStore } from './store'

/** Name of the built-in task that polls the Wald mailbox. */
export const MAILBOX_TASK_NAME = 'mailbox'

export interface MailboxSeedDeps {
  store: TaskStore
  runner: TaskRunner
  schedule: string
  channel: string
  channelTarget: string
}

/**
 * Ensure the mailbox poll task exists. Like the heartbeat, it is ordinary scheduled work on the
 * task runner rather than a listener of its own, and a user who paused or deleted it is
 * respected. The runner handles it mechanically: no model call unless the inbox holds work.
 */
export function seedMailboxTask(deps: MailboxSeedDeps): void {
  const existing = deps.store.list().find((t) => t.name === MAILBOX_TASK_NAME)
  if (existing) {
    if (existing.cronExpression !== deps.schedule) {
      deps.store.update(existing.id, { cronExpression: deps.schedule })
    }
    return
  }

  const task = deps.store.create({
    name: MAILBOX_TASK_NAME,
    description: 'Poll the Wald mailbox: resume delegations, take trusted requests',
    kind: 'scheduled',
    prompt: '', // Never sent to the model; the runner polls instead.
    cronExpression: deps.schedule,
    // Each poll records what it did; what matters reaches the principal on its own.
    notify: 'never',
    channel: deps.channel,
    channelTarget: deps.channelTarget,
    createdBy: 'system',
  })
  deps.runner.activateTask(task.id)
  log.info('mailbox', `Seeded mailbox task (${task.id}, schedule=${deps.schedule})`)
}
