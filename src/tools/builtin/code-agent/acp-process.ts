import type { Stream } from '@agentclientprotocol/sdk'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { spawn } from 'child_process'
import { Readable, Writable } from 'stream'
import { sanitizedEnv } from '../../../util/env'

/** A live connection to an ACP agent: the message stream, and a way to end it. */
export interface AcpTransport {
  stream: Stream
  /** Tail of the agent's stderr, for error reports. */
  stderr(): string
  /** Settles once the agent is gone. `force` kills it (and its children) outright. */
  close(force: boolean): Promise<void>
}

/** How long a polite close waits for the agent to exit before killing it. */
const POLITE_EXIT_MS = 2000
/** How long to wait for a killed agent to exit before giving up on it. */
const KILL_WAIT_MS = 1000
/** How long, after the agent exits, its pipes get to drain (stderr for error reports). */
const DRAIN_MS = 250

export type AcpConnect = (command: string[], cwd: string) => AcpTransport

/**
 * Spawn an ACP agent with JSON-RPC on its stdio. Most agents are launched through a wrapper
 * (npx, a shell script, a .cmd shim on Windows), so close kills the whole process tree, not
 * only the direct child.
 */
export function spawnAcpAgent(command: string[], cwd: string): AcpTransport {
  const [binary, ...args] = command
  if (!binary) throw new Error('ACP agent failed to start: acp_command is empty')
  const isWindows = process.platform === 'win32'
  const proc = spawn(binary, args, {
    cwd,
    env: sanitizedEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // npx and friends are .cmd shims on Windows, which only a shell can run.
    shell: isWindows,
    // Its own process group, so the tree can be killed together on POSIX.
    detached: !isWindows,
  })

  let stderr = ''
  proc.stderr.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-8000)
  })
  // 'exit', not 'close': close also waits for every holder of the stdio pipes, and a grandchild
  // that escaped the process tree can hold stdout open long after the agent is dead.
  let exited = proc.exitCode !== null || proc.signalCode !== null
  const exit = new Promise<void>((resolve) => {
    proc.on('exit', () => {
      exited = true
      resolve()
    })
    // A spawn failure (ENOENT) emits error and no close.
    proc.on('error', (error) => {
      exited = true
      stderr += `\nACP agent failed to start: ${error.message}`
      resolve()
    })
  })
  // Every holder of the pipes is gone, including descendants that inherited them.
  const drained = new Promise<void>((resolve) => proc.on('close', () => resolve()))
  // Writes after the agent died would otherwise surface as an unhandled EPIPE.
  proc.stdin.on('error', () => {})

  // Also run after the agent itself exited: on POSIX its group may still hold children.
  const killTree = (): void => {
    if (!proc.pid) return
    if (isWindows) {
      if (exited) return
      const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.on('error', () => proc.kill())
      return
    }
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      if (!exited) proc.kill('SIGKILL')
    }
  }

  // Drop our ends of the pipes so nothing an escaped descendant holds keeps the stream alive,
  // after a short drain so a crashed agent's last stderr still makes the error report.
  const release = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([drained, new Promise<void>((r) => (timer = setTimeout(r, DRAIN_MS)))])
    clearTimeout(timer)
    proc.stdin.destroy()
    proc.stdout.destroy()
    proc.stderr.destroy()
  }

  return {
    stream: ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>,
    ),
    stderr: () => stderr.trim(),
    async close(force) {
      if (exited) {
        if (force) killTree()
        await release()
        return
      }
      if (!force) proc.stdin.end()
      // A polite close gets a moment to exit on its own, then is killed; a kill that does not
      // take (a stuck taskkill, an unkillable process) stops being waited on after a bound.
      let timer: ReturnType<typeof setTimeout> | undefined
      const bounded = new Promise<void>((resolve) => {
        const kill = (): void => {
          killTree()
          timer = setTimeout(resolve, KILL_WAIT_MS)
        }
        timer = setTimeout(kill, force ? 0 : POLITE_EXIT_MS)
      })
      await Promise.race([exit, bounded])
      clearTimeout(timer)
      await release()
    },
  }
}
