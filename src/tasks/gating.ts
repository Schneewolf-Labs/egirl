import type { RuntimeConfig } from '../config'

/**
 * Whether the background task runner should exist, and if not, why.
 *
 * Three independent things have to line up, and the confusing one is the third: the whole
 * `[tasks]` section — a dozen settings including `enabled`, which defaults to TRUE — is gated
 * by `[tools] tasks`, which defaults to FALSE. So the normal state is a fully populated
 * `[tasks]` block that believes it is on while nothing runs, and `POST /tasks` answering a
 * bare "tasks disabled" that names neither flag. This centralizes the condition (it was
 * copy-pasted identically across four entry points, which is how such conditions drift) and
 * makes the reason reportable.
 */
export function taskRunnerEnabled(config: RuntimeConfig, hasStore: boolean): boolean {
  return hasStore && config.tasks.enabled && config.tools.tasks
}

/** Human-readable reason the runner is off, naming the exact flag. undefined when it is on. */
export function taskRunnerOffReason(config: RuntimeConfig, hasStore: boolean): string | undefined {
  if (!hasStore) return 'the task store failed to initialize'
  if (!config.tasks.enabled) return '[tasks] enabled = false'
  if (!config.tools.tasks)
    return '[tools] tasks = false (it defaults to false and gates the whole [tasks] section)'
  return undefined
}
