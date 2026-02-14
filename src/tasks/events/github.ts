import { log } from '../../util/logger'
import type { EventSource, EventPayload } from '../types'
import type { ToolExecutor } from '../../tools'

export type GitHubEventType =
  | 'push'
  | 'pr_opened'
  | 'pr_review'
  | 'pr_merged'
  | 'ci_complete'
  | 'ci_failed'
  | 'issue_opened'
  | 'issue_comment'
  | 'release'

export interface GitHubEventConfig {
  repo?: string
  events: GitHubEventType[]
  ref?: string
  poll_interval_ms?: number
}

interface PollState {
  [key: string]: string // event_type -> last-seen hash
}

/**
 * Polls GitHub using the native gh_* tools via ToolExecutor.
 * No LLM involved — just tool calls + hash comparison.
 */
export function createGitHubEventSource(
  config: GitHubEventConfig,
  toolExecutor: ToolExecutor,
  cwd: string,
): EventSource {
  let timer: ReturnType<typeof setInterval> | undefined
  let callback: ((payload: EventPayload) => void) | undefined
  const state: PollState = {}
  const pollMs = config.poll_interval_ms ?? 60_000

  async function pollEvent(eventType: GitHubEventType): Promise<void> {
    const toolName = getToolForEvent(eventType)
    const params = getParamsForEvent(eventType, config)

    const tool = toolExecutor.get(toolName)
    if (!tool) {
      log.warn('tasks', `GitHub tool ${toolName} not available for event ${eventType}`)
      return
    }

    try {
      const result = await tool.execute(params, cwd)
      if (!result.success) return

      const hash = await hashString(result.output)
      const stateKey = `${eventType}:${config.ref ?? 'default'}`
      const prev = state[stateKey]

      if (prev && prev !== hash) {
        // State changed — check if this is a relevant change
        const isRelevant = checkRelevance(eventType, result.output)
        if (isRelevant && callback) {
          callback({
            source: 'github',
            summary: `GitHub ${eventType}: change detected`,
            data: {
              event: eventType,
              ref: config.ref,
              repo: config.repo,
              output: result.output,
            },
          })
        }
      }

      state[stateKey] = hash
    } catch (err) {
      log.warn('tasks', `GitHub poll failed for ${eventType}: ${err}`)
    }
  }

  async function pollAll(): Promise<void> {
    for (const event of config.events) {
      await pollEvent(event)
    }
  }

  return {
    start(onTrigger) {
      callback = onTrigger
      // Initial poll to set baseline state (don't trigger on first run)
      pollAll().catch(err => log.warn('tasks', `Initial GitHub poll failed: ${err}`))
      timer = setInterval(() => {
        pollAll().catch(err => log.warn('tasks', `GitHub poll failed: ${err}`))
      }, pollMs)
      log.debug('tasks', `GitHub event source started: ${config.events.join(', ')} (${pollMs}ms)`)
    },

    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      callback = undefined
      log.debug('tasks', 'GitHub event source stopped')
    },
  }
}

function getToolForEvent(eventType: GitHubEventType): string {
  switch (eventType) {
    case 'push': return 'gh_ci_status'
    case 'pr_opened': return 'gh_pr_list'
    case 'pr_review': return 'gh_pr_list'
    case 'pr_merged': return 'gh_pr_list'
    case 'ci_complete': return 'gh_ci_status'
    case 'ci_failed': return 'gh_ci_status'
    case 'issue_opened': return 'gh_issue_list'
    case 'issue_comment': return 'gh_issue_list'
    case 'release': return 'gh_issue_list' // fallback — release tool doesn't exist yet
  }
}

function getParamsForEvent(
  eventType: GitHubEventType,
  config: GitHubEventConfig,
): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  if (config.repo) {
    const [owner, repo] = config.repo.split('/')
    base.owner = owner
    base.repo = repo
  }

  switch (eventType) {
    case 'push':
    case 'ci_complete':
    case 'ci_failed':
      return { ...base, ref: config.ref ?? 'HEAD' }
    case 'pr_opened':
      return { ...base, state: 'open', limit: 5 }
    case 'pr_review':
      return { ...base, state: 'open', limit: 5 }
    case 'pr_merged':
      return { ...base, state: 'closed', limit: 5 }
    case 'issue_opened':
      return { ...base, state: 'open', limit: 5 }
    case 'issue_comment':
      return { ...base, state: 'open', limit: 5 }
    case 'release':
      return { ...base, limit: 1 }
  }
}

function checkRelevance(eventType: GitHubEventType, output: string): boolean {
  // For CI failure events, only trigger if there's actually a failure
  if (eventType === 'ci_failed') {
    return output.toLowerCase().includes('fail') || output.toLowerCase().includes('error')
  }
  return true
}

async function hashString(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
