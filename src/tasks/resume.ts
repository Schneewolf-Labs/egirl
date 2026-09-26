import type { TaskRunner } from './runner'
import type { TaskStore } from './store'

/**
 * A message landing on a parked task's session is the resume signal: the exchange was just
 * persisted into the task's conversation, so the next run starts from it. Shared by every path
 * an answer can arrive on — POST /chat, and a delegation reply picked up from the mailbox.
 */
export function resumeParkedTask(
  sessionId: string,
  store: TaskStore | undefined,
  runner: TaskRunner | undefined,
  reason = 'Reply received on the task session — resuming',
): void {
  if (!sessionId.startsWith('task:') || !store) return
  const taskId = sessionId.slice('task:'.length)
  const parked = store.get(taskId)
  if (parked?.status === 'awaiting') {
    store.update(taskId, { status: 'active', nextRunAt: Date.now() }, reason)
  } else {
    // Not parked yet, but it may be about to: a run whose ask timed out parks when it ends.
    runner?.noteReply(taskId)
  }
}
