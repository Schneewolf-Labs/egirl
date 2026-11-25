/**
 * process_wait: block until something happens, in one tool call.
 *
 * Without it, watching a build or a long job meant `nohup`, then `ps`, `sleep` and `tail` in a
 * loop -- an operator reported burning dozens of turns that way. This waits inside the tool
 * instead, for one of three things, and returns what happened plus the output that arrived:
 *
 *   id    a process from process_start: its exit, new output, or a line matching `match`
 *   pid   any process on the machine (one started with nohup): its exit
 *   file  a log file: new content, or a line matching `match`
 *
 * It checks a few times a second, which costs nothing next to a model turn, and stops early
 * when the run is interrupted.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { resolveUserPath } from '../../util/paths'
import type { ProcessRegistry } from '../process-registry'
import type { Tool, ToolResult } from '../types'

const DEFAULT_TIMEOUT_S = 300
const MAX_TIMEOUT_S = 1800
const POLL_MS = 250
const TAIL_LINES = 30

export interface WaitDeps {
  registry: ProcessRegistry
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Whether an OS pid is alive; injectable for tests. */
  isAlive?: (pid: number) => boolean
}

/** One observation: whether the wait is over, and why. */
type Check = { done: false } | { done: true; why: string }

export function createProcessWaitTool(deps: WaitDeps): Tool {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
  const now = deps.now ?? Date.now
  const isAlive = deps.isAlive ?? pidAlive

  return {
    definition: {
      name: 'process_wait',
      description: [
        'Wait, in this one call, until a process exits or its output or a log file changes. Use it instead of sleep/ps/tail loops.',
        'Give exactly one of: id (a process_start process), pid (any process, e.g. one started with nohup), or file (a log file).',
        'until: "exit" (default for id/pid) or "output" (new output; default for file). match: a regex; returns at the first new line matching it.',
        'Returns what happened and the output that arrived while waiting.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Process id from process_start' },
          pid: { type: 'number', description: 'OS process id to wait on (exit only)' },
          file: { type: 'string', description: 'Path of a log file to watch' },
          until: { type: 'string', enum: ['exit', 'output'], description: 'What to wait for' },
          match: { type: 'string', description: 'Regex: stop at the first new line matching it' },
          timeout_seconds: {
            type: 'number',
            description: `Give up after this long (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})`,
          },
        },
      },
    },
    async execute(params, cwd, ctx): Promise<ToolResult> {
      const targets = ['id', 'pid', 'file'].filter((k) => params[k] !== undefined)
      if (targets.length !== 1) {
        return { success: false, output: 'Give exactly one of id, pid or file.' }
      }
      let match: RegExp | undefined
      if (typeof params.match === 'string' && params.match) {
        try {
          match = new RegExp(params.match)
        } catch (err) {
          return { success: false, output: `Invalid match regex: ${String(err)}` }
        }
      }
      const requested =
        typeof params.timeout_seconds === 'number' ? params.timeout_seconds : DEFAULT_TIMEOUT_S
      const timeoutS = Math.max(1, Math.min(MAX_TIMEOUT_S, requested))

      const watcher = makeWatcher(params, cwd, match, deps.registry, isAlive)
      if ('error' in watcher) return { success: false, output: watcher.error }

      const started = now()
      const deadline = started + timeoutS * 1000
      let check = watcher.check()
      while (!check.done) {
        if (ctx?.signal?.aborted) return finish('interrupted', watcher, started, now)
        if (now() >= deadline) return finish(`timed out after ${timeoutS}s`, watcher, started, now)
        await sleep(POLL_MS)
        check = watcher.check()
      }
      return finish(check.why, watcher, started, now)
    },
  }
}

interface Watcher {
  check(): Check
  /** Lines that arrived since the wait began, newest last. */
  newLines(): string[]
}

function finish(why: string, w: Watcher, started: number, now: () => number): ToolResult {
  const secs = Math.round((now() - started) / 1000)
  const lines = w.newLines()
  const shown = lines.slice(-TAIL_LINES)
  const skipped = lines.length - shown.length
  const body =
    lines.length === 0
      ? '(no new output)'
      : `${skipped > 0 ? `… ${skipped} earlier lines\n` : ''}${shown.join('\n')}`
  return { success: true, output: `${why} (waited ${secs}s)\n\nnew output:\n${body}` }
}

function makeWatcher(
  params: Record<string, unknown>,
  cwd: string,
  match: RegExp | undefined,
  registry: ProcessRegistry,
  isAlive: (pid: number) => boolean,
): Watcher | { error: string } {
  const until = params.until === 'output' || params.until === 'exit' ? params.until : undefined
  const matched = (lines: string[]): Check => {
    const hit = match ? lines.find((l) => match.test(l)) : undefined
    return hit !== undefined ? { done: true, why: `matched: ${hit}` } : { done: false }
  }

  if (typeof params.id === 'string') {
    const id = params.id
    const first = registry.output(id, { stream: 'both' })
    if (!first) return { error: `No process with id ${id}` }
    const from = { out: first.stdoutNextLine, err: first.stderrNextLine }
    const lines = (): string[] => {
      const o = registry.output(id, { stream: 'stdout', sinceLine: from.out })
      const e = registry.output(id, { stream: 'stderr', sinceLine: from.err })
      return [...(o?.stdout ?? []), ...(e?.stderr ?? []).map((l) => `[stderr] ${l}`)]
    }
    return {
      newLines: lines,
      check() {
        const snap = registry.list().find((p) => p.id === id)
        const got = lines()
        if (match) {
          const m = matched(got)
          if (m.done) return m
        } else if (until === 'output' && got.length > 0) {
          return { done: true, why: 'new output' }
        }
        if (snap && snap.status !== 'running') {
          return { done: true, why: `${snap.status} (exit ${snap.exitCode ?? snap.signal ?? '?'})` }
        }
        return { done: false }
      },
    }
  }

  if (params.pid !== undefined) {
    const pid = Number(params.pid)
    if (!Number.isInteger(pid) || pid <= 0) return { error: 'pid must be a positive integer' }
    if (match || until === 'output') {
      return {
        error: 'A bare pid can only be waited on for exit; watch its log with file instead.',
      }
    }
    if (!isAlive(pid)) return { error: `No running process with pid ${pid}` }
    return {
      newLines: () => [],
      check: () => (isAlive(pid) ? { done: false } : { done: true, why: `pid ${pid} exited` }),
    }
  }

  const path = resolveUserPath(String(params.file), cwd)
  let offset: number
  try {
    offset = statSync(path).size
  } catch {
    return { error: `Cannot read ${path}` }
  }
  let collected = ''
  const read = (): void => {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return
    }
    if (size < offset) offset = 0 // truncated or rotated: read it again from the top
    if (size === offset) return
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(size - offset)
      readSync(fd, buf, 0, buf.length, offset)
      collected += buf.toString('utf8')
      offset = size
    } finally {
      closeSync(fd)
    }
  }
  const lines = (): string[] => collected.split('\n').filter((l, i, all) => l || i < all.length - 1)
  return {
    newLines: lines,
    check() {
      read()
      if (match) return matched(lines())
      return collected.length > 0 ? { done: true, why: 'file changed' } : { done: false }
    },
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, it just is not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
