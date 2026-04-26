import { type ChildProcess, spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { sanitizedEnv } from '../util/env'
import { log } from '../util/logger'

export type ProcessStatus = 'running' | 'exited' | 'killed' | 'failed'

const MAX_LINES_PER_STREAM = 1000

interface RingBuffer {
  lines: string[]
  totalLines: number
  partial: string
}

interface ProcessEntry {
  id: string
  command: string
  cwd: string
  label?: string
  pid: number
  status: ProcessStatus
  startedAt: number
  exitedAt?: number
  exitCode?: number
  signal?: string
  stdout: RingBuffer
  stderr: RingBuffer
  child: ChildProcess
}

export interface StartOptions {
  command: string
  cwd: string
  label?: string
}

export interface ProcessSnapshot {
  id: string
  command: string
  cwd: string
  label?: string
  pid: number
  status: ProcessStatus
  startedAt: number
  exitedAt?: number
  exitCode?: number
  signal?: string
  stdoutLines: number
  stderrLines: number
}

export interface OutputSlice {
  status: ProcessStatus
  stdout: string[]
  stdoutNextLine: number
  stderr: string[]
  stderrNextLine: number
}

function newBuffer(): RingBuffer {
  return { lines: [], totalLines: 0, partial: '' }
}

function pushLine(buf: RingBuffer, line: string): void {
  buf.lines.push(line)
  buf.totalLines++
  if (buf.lines.length > MAX_LINES_PER_STREAM) buf.lines.shift()
}

function appendChunk(buf: RingBuffer, chunk: string): void {
  const combined = buf.partial + chunk
  const parts = combined.split('\n')
  buf.partial = parts.pop() ?? ''
  for (const line of parts) pushLine(buf, line)
}

function flushPartial(buf: RingBuffer): void {
  if (buf.partial.length > 0) {
    pushLine(buf, buf.partial)
    buf.partial = ''
  }
}

function readSlice(
  buf: RingBuffer,
  sinceLine: number | undefined,
  tailLines: number | undefined,
): { lines: string[]; nextLine: number } {
  const dropped = buf.totalLines - buf.lines.length
  let start = 0
  if (sinceLine !== undefined) {
    start = Math.max(0, sinceLine - dropped)
  }
  let lines = buf.lines.slice(start)
  if (tailLines !== undefined && tailLines >= 0 && lines.length > tailLines) {
    lines = lines.slice(-tailLines)
  }
  return { lines, nextLine: buf.totalLines }
}

/**
 * Tracks long-running child processes spawned by the agent.
 * Output is captured to a ring buffer so the agent can read recent lines
 * across turns. On hard exit, all children receive SIGKILL via the
 * registered process.on('exit') hook.
 */
export class ProcessRegistry {
  private processes = new Map<string, ProcessEntry>()
  private exitHandler?: () => void

  constructor() {
    this.exitHandler = () => {
      for (const entry of this.processes.values()) {
        if (entry.status === 'running') {
          try {
            entry.child.kill('SIGKILL')
          } catch {
            // best effort
          }
        }
      }
    }
    process.on('exit', this.exitHandler)
  }

  start(opts: StartOptions): ProcessSnapshot {
    const id = `proc_${randomBytes(3).toString('hex')}`
    const child = spawn(opts.command, {
      shell: true,
      cwd: opts.cwd,
      env: sanitizedEnv() as NodeJS.ProcessEnv,
    })

    const entry: ProcessEntry = {
      id,
      command: opts.command,
      cwd: opts.cwd,
      label: opts.label,
      pid: child.pid ?? -1,
      status: 'running',
      startedAt: Date.now(),
      stdout: newBuffer(),
      stderr: newBuffer(),
      child,
    }

    child.stdout?.on('data', (d: Buffer) => appendChunk(entry.stdout, d.toString()))
    child.stderr?.on('data', (d: Buffer) => appendChunk(entry.stderr, d.toString()))

    child.on('error', (err: Error) => {
      appendChunk(entry.stderr, `[spawn error] ${err.message}\n`)
      flushPartial(entry.stderr)
      if (entry.status === 'running') {
        entry.status = 'failed'
        entry.exitedAt = Date.now()
      }
      log.warn('process-registry', `${id} failed: ${err.message}`)
    })

    child.on('exit', (code, signal) => {
      flushPartial(entry.stdout)
      flushPartial(entry.stderr)
      entry.exitCode = code ?? undefined
      entry.signal = signal ?? undefined
      entry.exitedAt = Date.now()
      if (entry.status === 'running') {
        entry.status = signal ? 'killed' : 'exited'
      }
      log.debug('process-registry', `${id} exited code=${code ?? '?'} signal=${signal ?? '-'}`)
    })

    this.processes.set(id, entry)
    log.info('process-registry', `Started ${id} (pid ${entry.pid}): ${opts.command.slice(0, 60)}`)
    return this.snapshot(entry)
  }

  list(): ProcessSnapshot[] {
    return Array.from(this.processes.values()).map((e) => this.snapshot(e))
  }

  output(
    id: string,
    opts?: { stream?: 'stdout' | 'stderr' | 'both'; sinceLine?: number; tailLines?: number },
  ): OutputSlice | undefined {
    const entry = this.processes.get(id)
    if (!entry) return undefined
    const stream = opts?.stream ?? 'both'
    const stdout =
      stream === 'stderr'
        ? { lines: [], nextLine: entry.stdout.totalLines }
        : readSlice(entry.stdout, opts?.sinceLine, opts?.tailLines)
    const stderr =
      stream === 'stdout'
        ? { lines: [], nextLine: entry.stderr.totalLines }
        : readSlice(entry.stderr, opts?.sinceLine, opts?.tailLines)
    return {
      status: entry.status,
      stdout: stdout.lines,
      stdoutNextLine: stdout.nextLine,
      stderr: stderr.lines,
      stderrNextLine: stderr.nextLine,
    }
  }

  sendInput(id: string, data: string, opts?: { newline?: boolean }): boolean {
    const entry = this.processes.get(id)
    if (!entry || entry.status !== 'running') return false
    const stdin = entry.child.stdin
    if (!stdin || !stdin.writable) return false
    const payload = opts?.newline === false ? data : `${data}\n`
    stdin.write(payload)
    return true
  }

  async stop(
    id: string,
    opts?: { signal?: NodeJS.Signals; timeoutMs?: number },
  ): Promise<{ stopped: boolean; status: ProcessStatus }> {
    const entry = this.processes.get(id)
    if (!entry) return { stopped: false, status: 'exited' }
    if (entry.status !== 'running') return { stopped: true, status: entry.status }

    const signal = opts?.signal ?? 'SIGTERM'
    const timeoutMs = opts?.timeoutMs ?? 5000
    try {
      entry.child.kill(signal)
    } catch {
      // best effort
    }

    const start = Date.now()
    while (entry.status === 'running' && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50))
    }
    if (entry.status === 'running') {
      try {
        entry.child.kill('SIGKILL')
      } catch {
        // best effort
      }
      const killStart = Date.now()
      while (entry.status === 'running' && Date.now() - killStart < 1000) {
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    return { stopped: entry.status !== 'running', status: entry.status }
  }

  remove(id: string): boolean {
    const entry = this.processes.get(id)
    if (!entry) return false
    if (entry.status === 'running') return false
    return this.processes.delete(id)
  }

  async shutdownAll(timeoutMs = 5000): Promise<void> {
    const running = Array.from(this.processes.values()).filter((e) => e.status === 'running')
    await Promise.all(running.map((e) => this.stop(e.id, { timeoutMs })))
    if (this.exitHandler) {
      process.off('exit', this.exitHandler)
      this.exitHandler = undefined
    }
  }

  private snapshot(entry: ProcessEntry): ProcessSnapshot {
    return {
      id: entry.id,
      command: entry.command,
      cwd: entry.cwd,
      label: entry.label,
      pid: entry.pid,
      status: entry.status,
      startedAt: entry.startedAt,
      exitedAt: entry.exitedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      stdoutLines: entry.stdout.totalLines,
      stderrLines: entry.stderr.totalLines,
    }
  }
}

export function createProcessRegistry(): ProcessRegistry {
  return new ProcessRegistry()
}
