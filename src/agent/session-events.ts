/**
 * Session event bus — the one place a live run announces itself and narrates what it is doing.
 *
 * Every AgentLoop run publishes here regardless of who started it (a chat request, a background
 * task, a peer message, the CLI), so anything that wants to watch a session — the SSE spectator
 * route, the trace journal, a future channel — subscribes here instead of being threaded into
 * the loop's `events` handler by each caller. The wire shape is `{ t, v }` end to end: the same
 * object a subscriber receives is what goes down an SSE connection.
 *
 * A module-level singleton, like the trace store and the logger: one process, one set of
 * sessions, and the loop must be able to publish without every constructor site being taught
 * about a bus.
 */

import type { AgentLoop } from './loop'

export type SessionEvent =
  /** A run began on this session. */
  | { t: 'run_start'; v: { message: string } }
  /** An operator message was queued into the running turn (AgentLoop.inject). */
  | { t: 'inject'; v: string }
  | { t: 'reasoning'; v: string }
  | { t: 'token'; v: string }
  /** Tool calls about to execute, by name. */
  | { t: 'tool'; v: string[] }
  | {
      t: 'tool_done'
      v: { name: string; success: boolean; args: string; output: string }
    }
  /** One completed inference, with everything the journal keeps. */
  | {
      t: 'turn'
      v: {
        model: string
        input_tokens: number
        output_tokens: number
        duration_ms: number
        content: string
        thinking: string
        tool_calls: string
      }
    }
  | {
      t: 'run_end'
      v: {
        content: string
        input_tokens: number
        output_tokens: number
        turns: number
        duration_ms: number
        aborted: boolean
        awaiting: boolean
      }
    }
  /** The run threw. Always the last event of a run that ends this way. */
  | { t: 'error'; v: string }

export type SessionListener = (event: SessionEvent) => void
export type GlobalListener = (sessionId: string, event: SessionEvent) => void

interface RunningEntry {
  loop: AgentLoop
  startedAt: number
}

const running = new Map<string, RunningEntry>()
const listeners = new Map<string, Set<SessionListener>>()
const globalListeners = new Set<GlobalListener>()

export function publish(sessionId: string, event: SessionEvent): void {
  // A subscriber that throws must not take the run down with it: it is an observer.
  for (const fn of listeners.get(sessionId) ?? []) {
    try {
      fn(event)
    } catch {}
  }
  for (const fn of globalListeners) {
    try {
      fn(sessionId, event)
    } catch {}
  }
}

/** Watch one session. Returns the unsubscribe function. */
export function subscribe(sessionId: string, listener: SessionListener): () => void {
  let set = listeners.get(sessionId)
  if (!set) {
    set = new Set()
    listeners.set(sessionId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(sessionId)
  }
}

/** Watch every session. Returns the unsubscribe function. */
export function subscribeAll(listener: GlobalListener): () => void {
  globalListeners.add(listener)
  return () => {
    globalListeners.delete(listener)
  }
}

/**
 * Mark a run as live and announce it. The loop handle is what interrupt/inject reach for by
 * session id, wherever the run was started from.
 */
export function startRun(sessionId: string, loop: AgentLoop, message: string): void {
  running.set(sessionId, { loop, startedAt: Date.now() })
  publish(sessionId, { t: 'run_start', v: { message } })
}

/** The run is over, one way or the other. Cleared before publishing so `isRunning` agrees. */
export function endRun(
  sessionId: string,
  event: Extract<SessionEvent, { t: 'run_end' | 'error' }>,
): void {
  running.delete(sessionId)
  publish(sessionId, event)
}

export function isRunning(sessionId: string): boolean {
  return running.has(sessionId)
}

export function anyRunning(): boolean {
  return running.size > 0
}

export function runningSessions(): string[] {
  return [...running.keys()]
}

/** The loop driving a session's in-flight run, if any. */
export function runningLoop(sessionId: string): AgentLoop | undefined {
  return running.get(sessionId)?.loop
}

/** Test hook: forget every run and listener. */
export function resetSessionEvents(): void {
  running.clear()
  listeners.clear()
  globalListeners.clear()
}
