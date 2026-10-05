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
  let exited = proc.exitCode !== null
  const exit = new Promise<void>((resolve) => {
    proc.on('close', () => {
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
  // Writes after the agent died would otherwise surface as an unhandled EPIPE.
  proc.stdin.on('error', () => {})

  const killTree = (): void => {
    if (!proc.pid || exited) return
    if (isWindows) {
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
      proc.kill('SIGKILL')
    }
  }

  return {
    stream: ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>,
    ),
    stderr: () => stderr.trim(),
    async close(force) {
      if (exited) return
      if (force) killTree()
      else proc.stdin.end()
      // A polite close gets a moment to exit on its own.
      const timer = setTimeout(killTree, 2000)
      await exit
      clearTimeout(timer)
    },
  }
}
