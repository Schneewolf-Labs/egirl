import { subscribe } from '../agent/session-events'
import type { Tool, ToolResult } from '../tools/types'
import { trace } from '../tracking/traces'
import { log } from '../util/logger'
import type { RunDeadline } from './deadline'
import {
  decideExtension,
  type ExtensionDecision,
  type ExtensionPolicy,
  MIN_DISTINCT_CALLS,
  ProgressTracker,
} from './extensions'

/**
 * The two tools a bounded task run gets on top of the shared toolbelt: `request_extension`
 * (more time, granted by the runner on evidence) and `end_task` (stop now, with a status).
 * They exist only inside task runs — they act on this run's deadline and outcome — so they are
 * built per run and handed to the loop as extra tools, never registered on the executor.
 */

export type EndStatus = 'done' | 'blocked' | 'abandoned'

export interface EndRequest {
  status: EndStatus
  summary: string
}

export interface TaskControls {
  tools: Map<string, Tool>
  /** What end_task recorded, if the agent called it. */
  endRequest(): EndRequest | undefined
  dispose(): void
}

const END_STATUSES: readonly EndStatus[] = ['done', 'blocked', 'abandoned']

export function createTaskControls(opts: {
  sessionId: string
  taskName: string
  deadline: RunDeadline
  /** Offer request_extension (config `tasks.extensions`). */
  extensions: boolean
  policy: ExtensionPolicy
  /** A report tool exists, so a capped-out agent can be pointed at report(mode=ask). */
  canReport: boolean
}): TaskControls {
  const { sessionId, taskName, deadline, policy } = opts
  const tracker = new ProgressTracker()
  let grants = 0
  let ended: EndRequest | undefined

  // Evidence comes from the session bus, the same record the journal keeps — what the tools
  // actually returned, not what the model says it did.
  const unsubscribe = subscribe(sessionId, (event) => {
    if (event.t === 'tool_done') tracker.recordTool(event.v.name, event.v.args, event.v.success)
    else if (event.t === 'repeat_warning') tracker.recordRepeat()
  })

  const requestExtension: Tool = {
    definition: {
      name: 'request_extension',
      description:
        "Ask for more time before this task run's deadline. The runner decides from what this " +
        'run has actually done since it started (or since the last extension) — distinct ' +
        'successful tool calls, files written, commits made, no looping — not from the request ' +
        'itself. Call it only when you have been making real progress and know what remains.',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: 'How many more minutes you need.' },
          reason: { type: 'string', description: 'Why the extra time is needed.' },
          remaining: { type: 'string', description: 'The concrete steps still left to do.' },
        },
        required: ['minutes', 'reason', 'remaining'],
      },
    },
    async execute(params): Promise<ToolResult> {
      const requested = typeof params.minutes === 'number' ? params.minutes : Number(params.minutes)
      const decision = decideExtension({
        requestedMinutes: requested,
        evidence: tracker.snapshot(),
        grantsSoFar: grants,
        extendedMsSoFar: deadline.extended,
        policy,
      })
      if (decision.verdict === 'granted') {
        deadline.extend(decision.grantedMs)
        grants = decision.grantsSoFar
        tracker.checkpoint()
      }
      recordDecision(sessionId, taskName, decision, requested, params, deadline.at)
      return { success: decision.verdict === 'granted', output: explain(decision, opts.canReport) }
    },
  }

  const endTask: Tool = {
    definition: {
      name: 'end_task',
      description:
        'Stop this task run now, cleanly. status=done: the work is finished (the summary ' +
        'becomes the result). status=blocked: you cannot continue without something outside ' +
        'your control; the task stops and waits for the operator. status=abandoned: the task ' +
        'should not continue; recorded as a failure and not retried. No further turns follow.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: [...END_STATUSES] },
          summary: {
            type: 'string',
            description: 'What was done, and for blocked/abandoned, why — the operator reads this.',
          },
        },
        required: ['status', 'summary'],
      },
    },
    async execute(params): Promise<ToolResult> {
      const status = params.status
      const summary = typeof params.summary === 'string' ? params.summary.trim() : ''
      if (!END_STATUSES.includes(status as EndStatus) || !summary) {
        return {
          success: false,
          output: 'end_task needs status (done, blocked or abandoned) and a non-empty summary.',
        }
      }
      ended = { status: status as EndStatus, summary }
      log.info('tasks', `Task ${taskName}: end_task(${status})`)
      trace({ session: sessionId, kind: 'decision', name: 'end_task', payload: { ...ended } })
      return {
        success: true,
        output: `Task run ended (${status}). No further turns.`,
        endRun: { content: endContent(ended) },
      }
    },
  }

  const tools = new Map<string, Tool>([[endTask.definition.name, endTask]])
  if (opts.extensions) tools.set(requestExtension.definition.name, requestExtension)

  return { tools, endRequest: () => ended, dispose: unsubscribe }
}

/** The run's final content for an end_task stop: blocked is marked so it reads as such. */
export function endContent(end: EndRequest): string {
  return end.status === 'blocked' ? `[Blocked] ${end.summary}` : end.summary
}

function recordDecision(
  sessionId: string,
  taskName: string,
  decision: ExtensionDecision,
  requested: number,
  params: Record<string, unknown>,
  deadlineAt: number,
): void {
  const e = decision.evidence
  log.info(
    'tasks',
    `Task ${taskName}: extension ${decision.verdict}` +
      (decision.verdict === 'granted' ? ` (+${minutes(decision.grantedMs)})` : '') +
      ` — requested ${requested} min; evidence: ${e.distinctCalls} distinct calls, ` +
      `${e.artifactActions} artifact actions, ${e.repeatTrips} repeat trips`,
  )
  trace({
    session: sessionId,
    kind: 'decision',
    name: 'request_extension',
    success: decision.verdict === 'granted',
    payload: {
      verdict: decision.verdict,
      requested_minutes: requested,
      granted_ms: decision.grantedMs,
      reason: typeof params.reason === 'string' ? params.reason : '',
      remaining: typeof params.remaining === 'string' ? params.remaining : '',
      distinct_calls: e.distinctCalls,
      artifact_actions: e.artifactActions,
      repeat_trips: e.repeatTrips,
      grants_so_far: decision.grantsSoFar,
      remaining_cap_ms: decision.remainingCapMs,
      deadline_at: deadlineAt,
    },
  })
}

function explain(decision: ExtensionDecision, canReport: boolean): string {
  const e = decision.evidence
  const seen = `${e.distinctCalls} distinct successful tool calls and ${e.artifactActions} artifact actions (files written, commits)`
  const wrapUp = 'Wrap up now: save your work, then call end_task (done or blocked) with a summary.'
  switch (decision.verdict) {
    case 'granted':
      return `Extension granted: +${minutes(decision.grantedMs)}. Use it to finish the remaining steps; ${minutes(decision.remainingCapMs)} of extension remain available.`
    case 'invalid':
      return 'Extension denied: minutes must be a positive number.'
    case 'repeating':
      return `Extension denied: this run repeated the same tool call since the last checkpoint, which looks like a loop rather than progress. ${wrapUp}`
    case 'no_progress':
      return `Extension denied: not enough measurable progress since the run started or the last extension (${seen}; needs at least one artifact action or ${MIN_DISTINCT_CALLS} distinct calls). ${wrapUp}`
    case 'cap_reached': {
      const ask = canReport
        ? ' If the work truly needs more time, you may ask the human with report(mode=ask).'
        : ''
      return `Extension denied: the extension limit for this run is reached. ${wrapUp}${ask}`
    }
  }
}

/** A duration for the model: whole minutes, or seconds when under one. */
function minutes(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`
}

/** Opens a run that continues one stopped by its time limit; the earlier transcript precedes it. */
export function timeoutResumeNudge(minutes: number): string {
  return `[Your previous run hit its time limit after ${minutes} min and was stopped mid-way. Your messages and tool results so far are above; files you wrote and commits you made are in place. Check what's already done and continue from there — don't redo finished steps.]`
}
