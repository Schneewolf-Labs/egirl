import { spawn } from 'child_process'
import { sanitizedEnv } from '../../../util/env'
import { log } from '../../../util/logger'
import { DEFAULT_TIMEOUT_MS } from './shared'
import type { CodeAgentBackend, CodeAgentConfig } from './types'

interface OpencodeEvent {
  type: string
  properties?: Record<string, unknown>
}

interface OpencodePermission {
  id: string
  type: string
  title: string
  sessionID: string
  metadata: Record<string, unknown>
}

interface OpencodePromptResponse {
  info: { error?: unknown }
  parts: { type: string; text?: string; synthetic?: boolean }[]
}

const LISTEN_RE = /listening on (http:\/\/\S+)/i

function parseModel(
  model: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!model || !model.includes('/')) return undefined
  const [providerID, ...rest] = model.split('/')
  return providerID ? { providerID, modelID: rest.join('/') } : undefined
}

function waitForServer(proc: ReturnType<typeof spawn>, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const cleanup = (): void => {
      clearTimeout(timer)
      proc.stdout?.off('data', onData)
      proc.stderr?.off('data', onData)
      proc.off('error', onError)
    }
    const onData = (data: Buffer): void => {
      buffer += data.toString()
      const match = buffer.match(LISTEN_RE)
      if (match?.[1]) {
        cleanup()
        resolve(match[1])
      }
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`opencode server did not start within ${timeoutMs}ms\n${buffer}`))
    }, timeoutMs)
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', onError)
  })
}

// Server events stream as SSE frames ("data: <json>\n\n") on GET /event.
async function streamEvents(
  baseUrl: string,
  signal: AbortSignal,
  onEvent: (event: OpencodeEvent) => void,
): Promise<void> {
  const response = await fetch(`${baseUrl}/event`, { signal })
  const reader = response.body?.getReader()
  if (!reader) return

  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const dataLine = frame.split('\n').find((line) => line.startsWith('data:'))
      if (!dataLine) continue
      try {
        onEvent(JSON.parse(dataLine.slice(5).trim()) as OpencodeEvent)
      } catch {
        // ignore malformed frame
      }
    }
  }
}

async function replyToPermission(
  baseUrl: string,
  permission: OpencodePermission,
  response: 'once' | 'reject',
): Promise<void> {
  try {
    await fetch(`${baseUrl}/session/${permission.sessionID}/permissions/${permission.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response }),
    })
  } catch (error) {
    log.error('code-agent', `opencode: failed to reply to permission ${permission.id}: ${error}`)
  }
}

async function handlePermission(
  config: CodeAgentConfig,
  task: string,
  workingDir: string,
  baseUrl: string,
  permission: OpencodePermission,
  onEscalate: (reason: string) => void,
): Promise<void> {
  if (config.permissionMode === 'bypassPermissions' || !config.permissionSupervisor) {
    await replyToPermission(baseUrl, permission, 'once')
    return
  }

  const decision = await config.permissionSupervisor.decide({
    backend: 'opencode',
    kind: 'permission',
    originalTask: task,
    workingDir,
    toolName: permission.type,
    toolInput: permission.metadata,
    promptText: `opencode requests permission: ${permission.title}`,
  })

  if (decision.action === 'ask_user') {
    onEscalate(decision.reason)
    await replyToPermission(baseUrl, permission, 'reject')
    return
  }

  await replyToPermission(baseUrl, permission, decision.action === 'deny' ? 'reject' : 'once')
}

export const runOpencodeCodeAgent: CodeAgentBackend = async (config, task, workingDir) => {
  const startTime = Date.now()
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const abortController = new AbortController()
  let timedOut = false
  let escalation: string | undefined
  const timeoutId = setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, timeoutMs)

  const proc = spawn('opencode', ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
    cwd: workingDir,
    env: { ...sanitizedEnv(), NO_COLOR: '1' },
  })

  const eventStreamController = new AbortController()

  try {
    const baseUrl = await waitForServer(proc, timeoutMs)
    log.debug('code-agent', `opencode server: ${baseUrl}`)

    const createRes = await fetch(
      `${baseUrl}/session?directory=${encodeURIComponent(workingDir)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: task.slice(0, 80) }),
        signal: abortController.signal,
      },
    )
    if (!createRes.ok) {
      throw new Error(
        `Failed to create opencode session: ${createRes.status} ${await createRes.text()}`,
      )
    }
    const session = (await createRes.json()) as { id: string }

    streamEvents(baseUrl, eventStreamController.signal, (event) => {
      if (event.type !== 'permission.updated') return
      const permission = event.properties as unknown as OpencodePermission
      if (permission.sessionID !== session.id) return
      handlePermission(config, task, workingDir, baseUrl, permission, (reason) => {
        escalation = reason
        abortController.abort()
      }).catch((error) => log.error('code-agent', `opencode permission handling failed: ${error}`))
    }).catch(() => {
      // event stream ends when the server is killed; nothing to report
    })

    const model = parseModel(config.model)
    const promptRes = await fetch(
      `${baseUrl}/session/${session.id}/message?directory=${encodeURIComponent(workingDir)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(model && { model }),
          parts: [{ type: 'text', text: task }],
        }),
        signal: abortController.signal,
      },
    )
    if (!promptRes.ok) {
      throw new Error(`opencode prompt failed: ${promptRes.status} ${await promptRes.text()}`)
    }
    const result = (await promptRes.json()) as OpencodePromptResponse

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1)

    if (result.info.error) {
      return { success: false, output: `Code agent error: ${JSON.stringify(result.info.error)}` }
    }

    const finalText = result.parts
      .filter((part) => part.type === 'text' && !part.synthetic && part.text)
      .map((part) => part.text)
      .join('\n\n')

    log.info('code-agent', `opencode completed in ${durationSec}s`)

    return {
      success: true,
      output: `${finalText}\n\n[code_agent: opencode | ${durationSec}s | session: ${session.id.slice(0, 8)}]`,
    }
  } catch (error) {
    if (escalation) {
      return {
        success: false,
        output: `Code agent needs user approval before continuing.\n\n${escalation}`,
      }
    }
    if (timedOut) {
      return {
        success: false,
        output: `Code agent timed out after ${(timeoutMs / 1000).toFixed(0)}s`,
      }
    }
    const msg = error instanceof Error ? error.message : String(error)
    log.error('code-agent', `opencode task failed: ${msg}`)
    return { success: false, output: `Code agent error: ${msg}` }
  } finally {
    clearTimeout(timeoutId)
    eventStreamController.abort()
    proc.kill('SIGTERM')
  }
}
