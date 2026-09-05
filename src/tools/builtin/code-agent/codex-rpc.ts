import { spawn } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { sanitizedEnv } from '../../../util/env'

export type RpcObject = Record<string, unknown>
export interface CodexConnection {
  request(method: string, params: RpcObject): Promise<RpcObject>
  notify(method: string, params: RpcObject): void
  respond(id: string | number, result: RpcObject): void
  reject(id: string | number, message: string): void
  close(force: boolean): Promise<void>
}
export interface CodexEvents {
  notification(method: string, params: RpcObject): void
  request(id: string | number, method: string, params: RpcObject): Promise<void>
  failure(error: Error): void
}
export function object(value: unknown): RpcObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RpcObject)
    : {}
}

/** Newline-delimited JSON-RPC over stdio; no terminal, shell, or Node shim. */
export function connectCodex(
  cwd: string,
  events: CodexEvents,
  binary = process.env.EGIRL_CODEX_BIN ?? (process.platform === 'win32' ? 'codex.exe' : 'codex'),
  args = ['app-server', '--listen', 'stdio://'],
): CodexConnection {
  const proc = spawn(binary, args, {
    cwd,
    env: sanitizedEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  const pending = new Map<number, { resolve(value: RpcObject): void; reject(error: Error): void }>()
  const decoder = new StringDecoder('utf8')
  let nextId = 0
  let buffer = ''
  let stderr = ''
  let closing = false
  let exited = false
  let closed: () => void = () => {}
  const exit = new Promise<void>((resolve) => {
    closed = resolve
  })
  const fail = (error: Error): void => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    if (!closing) events.failure(error)
  }
  const send = (message: RpcObject): void => {
    if (closing || exited) throw new Error('Codex connection closed')
    proc.stdin.write(`${JSON.stringify(message)}\n`)
  }
  proc.on('error', fail)
  proc.stdin.on('error', fail)
  proc.stderr.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-8000)
  })
  proc.stdout.on('data', (data: Buffer) => {
    buffer += decoder.write(data)
    if (buffer.length > 16 * 1024 * 1024) {
      fail(new Error('Codex protocol frame exceeds 16 MiB'))
      return
    }
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line.trim()) continue
      try {
        const message = object(JSON.parse(line))
        const id = message.id
        if (typeof message.method === 'string') {
          if (typeof id === 'number' || typeof id === 'string') {
            void events.request(id, message.method, object(message.params)).catch(fail)
          } else events.notification(message.method, object(message.params))
        } else if (typeof id === 'number') {
          const request = pending.get(id)
          if (!request) continue
          pending.delete(id)
          if (message.error) request.reject(new Error(JSON.stringify(message.error)))
          else request.resolve(object(message.result))
        }
      } catch (error) {
        fail(new Error(`Invalid Codex protocol: ${String(error)}`))
      }
    }
  })
  proc.on('close', (code) => {
    exited = true
    fail(new Error(`Codex exited before completion (code ${code}). ${stderr}`))
    closed()
  })
  const killTree = (): void => {
    if (!proc.pid || exited) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.on('error', () => proc.kill())
    } else {
      try {
        process.kill(-proc.pid, 'SIGKILL')
      } catch {
        proc.kill('SIGKILL')
      }
    }
  }
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject })
        try {
          send({ id, method, params })
        } catch (error) {
          pending.delete(id)
          reject(error)
        }
      })
    },
    notify: (method, params) => send({ method, params }),
    respond: (id, result) => send({ id, result }),
    reject: (id, message) => send({ id, error: { code: -32601, message } }),
    async close(force) {
      closing = true
      fail(new Error('Codex connection closed'))
      if (exited) return
      if (force) killTree()
      else proc.stdin.end()
      const timer = setTimeout(killTree, 2000)
      await exit
      clearTimeout(timer)
    },
  }
}
