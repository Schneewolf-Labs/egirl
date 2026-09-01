import { randomBytes } from 'crypto'
import { log } from '../util/logger'
import type { ToolResult } from './types'

/**
 * Registry of backgrounded code-agent delegations.
 *
 * A foreground `code_agent` call blocks the operator until the code agent is done: it cannot
 * look at what the delegate is doing, cannot correct a run that has gone the wrong way, and
 * cannot stop one without losing everything it did. This registry is the other mode — the
 * delegation becomes a handle the operator holds, the same way `process_start` turns a shell
 * command into a handle (see ./process-registry.ts, whose shape this deliberately mirrors).
 *
 * Two things make it more than a list of promises:
 *
 * **Steering is a channel, not a flag.** A backend that supports mid-run input drains
 * `nextSteer()` and the operator fills it with `code_agent_steer`. Backends that cannot take
 * input mid-run declare `steerable: false` and the tool says so, rather than accepting a
 * message that goes nowhere.
 *
 * **Finishing is announced, not polled.** A completed delegation leaves a notice here; the
 * agent loop drains notices at a turn boundary. An operator that started a 20-minute
 * refactor and moved on gets told when it lands instead of having to remember to check.
 */

export type DelegationStatus = 'running' | 'done' | 'failed' | 'stopped'

/** Progress lines kept per delegation. Oldest are dropped. */
const MAX_EVENT_LINES = 500

/**
 * Cap on how much of a result goes into the completion notice.
 *
 * The notice is injected into the operator's context whether or not it asked for it right
 * then, and a backend's output is not always a tidy summary — the Codex backend returns its
 * whole terminal transcript. Unbounded, one finished delegation could eat the context window
 * the operator is working in. The full result stays one `code_agent_status` call away.
 */
const MAX_NOTICE_CHARS = 4000

/**
 * The control channel handed to a backend that is running in the background. Absent for
 * foreground runs, which is what keeps the blocking path byte-for-byte what it was.
 */
export interface DelegationControl {
  /** Aborts when the operator calls `code_agent_stop`, or on the background timeout. */
  signal: AbortSignal
  /** Record a line of progress. Cheap and lossy — it feeds `code_agent_status`, not the result. */
  onProgress(line: string): void
  /** Report cost/turns as the backend learns them, so status is useful before the run ends. */
  onStats(stats: { costUsd?: number; turns?: number }): void
  /**
   * Next steering message, or undefined once the channel is closed. Backends that support
   * mid-run input await this; the promise parks until a steer arrives or the run closes.
   */
  nextSteer(): Promise<string | undefined>
  /**
   * Close the steering channel — the backend calls this when a turn ends and it is ready to
   * settle. Returns false when a steer arrived first, meaning the backend must keep going and
   * deliver it instead of finishing.
   */
  closeSteering(): boolean
}

export interface DelegationSnapshot {
  id: string
  task: string
  provider: string
  workingDir: string
  status: DelegationStatus
  steerable: boolean
  startedAt: number
  finishedAt: number | undefined
  eventCount: number
  steerCount: number
  costUsd: number | undefined
  turns: number | undefined
  /** Present once settled. */
  resultOk: boolean | undefined
}

export interface DelegationOutput extends DelegationSnapshot {
  lines: string[]
  nextLine: number
  result: string | undefined
}

export type SteerOutcome = 'sent' | 'unknown' | 'not_running' | 'not_steerable'

interface Entry {
  id: string
  task: string
  provider: string
  workingDir: string
  status: DelegationStatus
  steerable: boolean
  startedAt: number
  finishedAt?: number
  costUsd?: number
  turns?: number
  result?: ToolResult
  /** Ring buffer of progress lines. */
  lines: string[]
  totalLines: number
  steerCount: number
  controller: AbortController
  queue: string[]
  waiter?: (value: string | undefined) => void
  closed: boolean
  stopRequested: boolean
}

export interface DelegationRegistry {
  /** Register a run and get the control channel to hand the backend. */
  begin(opts: { task: string; provider: string; workingDir: string; steerable: boolean }): {
    id: string
    control: DelegationControl
  }
  /** Record the terminal result. `status` overrides the success/failure default. */
  settle(id: string, result: ToolResult, status?: DelegationStatus): void
  /**
   * Re-point an entry at another backend after a failover, so status keeps naming the agent
   * that is actually running and steering stops being offered if the new one cannot take it.
   */
  setBackend(id: string, provider: string, steerable: boolean): void
  list(): DelegationSnapshot[]
  get(id: string): DelegationSnapshot | undefined
  output(
    id: string,
    opts?: { sinceLine?: number; tailLines?: number },
  ): DelegationOutput | undefined
  steer(id: string, message: string): SteerOutcome
  stop(id: string): boolean
  /** Drain completion notices. The agent loop calls this at a turn boundary. */
  takeNotices(): string[]
  /** Abort everything still running (shutdown). */
  stopAll(): void
}

function snapshot(entry: Entry): DelegationSnapshot {
  return {
    id: entry.id,
    task: entry.task,
    provider: entry.provider,
    workingDir: entry.workingDir,
    status: entry.status,
    steerable: entry.steerable,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    eventCount: entry.totalLines,
    steerCount: entry.steerCount,
    costUsd: entry.costUsd,
    turns: entry.turns,
    resultOk: entry.result?.success,
  }
}

/** The completion notice the operator sees, capped so one delegation cannot flood its context. */
function notice(entry: Entry): string {
  const seconds = (((entry.finishedAt ?? Date.now()) - entry.startedAt) / 1000).toFixed(0)
  const head = `Delegation ${entry.id} (${entry.provider}) ${entry.status} after ${seconds}s: ${entry.task}`
  const output = entry.result?.output ?? '(no output)'
  const body =
    output.length > MAX_NOTICE_CHARS
      ? `${output.slice(0, MAX_NOTICE_CHARS)}\n\n[truncated — read it all with code_agent_status(id: "${entry.id}")]`
      : output
  return `${head}\n\n${body}`
}

export function createDelegationRegistry(): DelegationRegistry {
  const entries = new Map<string, Entry>()
  const notices: string[] = []

  const push = (entry: Entry, line: string): void => {
    entry.lines.push(line)
    entry.totalLines++
    if (entry.lines.length > MAX_EVENT_LINES) entry.lines.shift()
  }

  return {
    begin({ task, provider, workingDir, steerable }) {
      const id = `d${randomBytes(3).toString('hex')}`
      const entry: Entry = {
        id,
        task,
        provider,
        workingDir,
        status: 'running',
        steerable,
        startedAt: Date.now(),
        lines: [],
        totalLines: 0,
        steerCount: 0,
        controller: new AbortController(),
        queue: [],
        closed: false,
        stopRequested: false,
      }
      entries.set(id, entry)
      log.info('code-agent', `Delegation ${id} started in background (${provider})`)

      const control: DelegationControl = {
        signal: entry.controller.signal,
        onProgress: (line) => {
          const trimmed = line.trim()
          if (trimmed.length > 0) push(entry, trimmed)
        },
        onStats: (stats) => {
          if (stats.costUsd !== undefined) entry.costUsd = stats.costUsd
          if (stats.turns !== undefined) entry.turns = stats.turns
        },
        nextSteer: () => {
          const queued = entry.queue.shift()
          if (queued !== undefined) return Promise.resolve(queued)
          if (entry.closed) return Promise.resolve(undefined)
          return new Promise<string | undefined>((resolve) => {
            entry.waiter = resolve
          })
        },
        closeSteering: () => {
          // A steer that arrived while the backend was deciding to finish must win, or the
          // operator's correction is silently dropped on a run that then reports success.
          if (entry.queue.length > 0) return false
          entry.closed = true
          entry.waiter?.(undefined)
          entry.waiter = undefined
          return true
        },
      }

      return { id, control }
    },

    settle(id, result, status) {
      const entry = entries.get(id)
      if (!entry) return
      if (entry.status !== 'running') return
      entry.result = result
      entry.finishedAt = Date.now()
      entry.closed = true
      entry.waiter?.(undefined)
      entry.waiter = undefined
      entry.status =
        status ?? (entry.stopRequested ? 'stopped' : result.success ? 'done' : 'failed')
      notices.push(notice(entry))
      log.info('code-agent', `Delegation ${id} ${entry.status}`)
    },

    setBackend(id, provider, steerable) {
      const entry = entries.get(id)
      if (!entry) return
      entry.provider = provider
      entry.steerable = steerable
      push(entry, `[failover] now running on ${provider}`)
      if (!steerable && entry.queue.length > 0) {
        // Nothing will ever read these. Saying so beats a steer that quietly evaporates.
        push(entry, `[dropped ${entry.queue.length} steer(s): ${provider} cannot take input]`)
        entry.queue.length = 0
      }
    },

    list() {
      return [...entries.values()].map(snapshot)
    },

    get(id) {
      const entry = entries.get(id)
      return entry ? snapshot(entry) : undefined
    },

    output(id, opts = {}) {
      const entry = entries.get(id)
      if (!entry) return undefined
      const dropped = entry.totalLines - entry.lines.length
      const since = Math.max(opts.sinceLine ?? 0, dropped)
      let lines = entry.lines.slice(since - dropped)
      if (opts.tailLines !== undefined && lines.length > opts.tailLines) {
        lines = lines.slice(-opts.tailLines)
      }
      return {
        ...snapshot(entry),
        lines,
        nextLine: entry.totalLines,
        result: entry.result?.output,
      }
    },

    steer(id, message) {
      const entry = entries.get(id)
      if (!entry) return 'unknown'
      if (!entry.steerable) return 'not_steerable'
      if (entry.status !== 'running' || entry.closed) return 'not_running'
      entry.steerCount++
      if (entry.waiter) {
        const resolve = entry.waiter
        entry.waiter = undefined
        resolve(message)
      } else {
        entry.queue.push(message)
      }
      push(entry, `[steer] ${message}`)
      return 'sent'
    },

    stop(id) {
      const entry = entries.get(id)
      if (!entry || entry.status !== 'running') return false
      entry.stopRequested = true
      entry.closed = true
      entry.waiter?.(undefined)
      entry.waiter = undefined
      entry.controller.abort()
      return true
    },

    takeNotices() {
      return notices.splice(0)
    },

    stopAll() {
      for (const entry of entries.values()) {
        if (entry.status === 'running') {
          entry.stopRequested = true
          entry.closed = true
          entry.waiter?.(undefined)
          entry.waiter = undefined
          entry.controller.abort()
        }
      }
    },
  }
}
