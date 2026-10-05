import * as acp from '@agentclientprotocol/sdk'
import { isAbsolute } from 'path'
import type { AgentEventHandler } from '../agent/events'
import type { AgentLoop } from '../agent/loop'
import { log } from '../util/logger'

/**
 * egirl as an ACP agent: an editor (Zed, a JetBrains IDE, any ACP client) drives an egirl session
 * over JSON-RPC on stdio. One ACP session is one egirl agent session; a prompt is one agent run,
 * streamed back as `session/update` notifications.
 *
 * Deliberately small. No session loading, no modes, no MCP servers from the client, and no use of
 * the client's fs/terminal capabilities: egirl's own tools do the work, in its own process.
 */

/** The part of AgentLoop a session needs. A seam for tests; the command passes real loops. */
export type AcpSessionLoop = Pick<AgentLoop, 'run' | 'interrupt'>

/** Builds the loop behind a new ACP session. `cwd` is the editor's project directory. */
export type AcpLoopFactory = (sessionId: string, cwd: string) => AcpSessionLoop

interface AcpSession {
  loop: AcpSessionLoop
  cwd: string
  /** Set while a prompt is running; `session/cancel` aborts it. */
  controller?: AbortController
}

export const EGIRL_AGENT_INFO = { name: 'egirl', version: '0.1.0' }

// Tool output is shown in the editor's tool-call panel; the agent keeps the full text.
const TOOL_OUTPUT_PREVIEW_CHARS = 4000

function toolKind(name: string): acp.ToolKind {
  if (name === 'read_file' || name === 'glob_files') return 'read'
  if (name === 'write_file' || name === 'edit_file') return 'edit'
  if (name === 'execute_command' || name === 'code_agent') return 'execute'
  if (name.startsWith('web_') || name.startsWith('browser_')) return 'fetch'
  if (name.includes('search')) return 'search'
  return 'other'
}

/**
 * Flatten an ACP prompt into the text and images an egirl run takes. Text and embedded text
 * resources are inlined; a resource link (a file the user @-mentioned) is named so the agent
 * can read it with its own tools; images become data: URLs, the shape the loop already feeds a
 * vision-capable provider.
 */
export function promptToRun(prompt: acp.ContentBlock[]): { text: string; images: string[] } {
  const parts: string[] = []
  const images: string[] = []
  for (const block of prompt) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') images.push(`data:${block.mimeType};base64,${block.data}`)
    else if (block.type === 'resource_link') parts.push(`[Referenced file: ${block.uri}]`)
    else if (block.type === 'resource') {
      const resource = block.resource
      parts.push(
        'text' in resource
          ? `[Attached ${resource.uri}]\n\`\`\`\n${resource.text}\n\`\`\``
          : `[Attached binary resource: ${resource.uri}]`,
      )
    }
  }
  return { text: parts.join('\n\n'), images }
}

export function createAcpAgent(createLoop: AcpLoopFactory): acp.AgentApp {
  const sessions = new Map<string, AcpSession>()

  const getSession = (sessionId: string): AcpSession => {
    const session = sessions.get(sessionId)
    if (!session) throw acp.RequestError.invalidParams({ sessionId }, 'Unknown session')
    return session
  }

  return acp
    .agent({ name: 'egirl' })
    .onConnect((connection) => {
      // The editor went away: stop whatever it started rather than leave runs nobody will read.
      connection.signal.addEventListener('abort', () => {
        for (const session of sessions.values()) session.controller?.abort()
      })
    })
    .onRequest('initialize', ({ params }) => {
      log.info(
        'acp',
        `Client: ${params.clientInfo?.name ?? 'unknown'} (protocol ${params.protocolVersion})`,
      )
      return {
        // Only v1 exists; a client asking for anything else gets the version we speak.
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
        },
        agentInfo: EGIRL_AGENT_INFO,
        authMethods: [],
      }
    })
    .onRequest('session/new', ({ params }) => {
      if (!isAbsolute(params.cwd)) {
        throw acp.RequestError.invalidParams({ cwd: params.cwd }, 'cwd must be an absolute path')
      }
      if (params.mcpServers.length > 0) {
        log.warn('acp', `Ignoring ${params.mcpServers.length} client MCP server(s): not supported`)
      }
      const sessionId = `acp:${crypto.randomUUID()}`
      sessions.set(sessionId, { loop: createLoop(sessionId, params.cwd), cwd: params.cwd })
      log.info('acp', `New session ${sessionId} in ${params.cwd}`)
      return { sessionId }
    })
    .onRequest('session/prompt', async ({ params, client }) => {
      const session = getSession(params.sessionId)
      if (session.controller) {
        throw acp.RequestError.invalidRequest(
          { sessionId: params.sessionId },
          'A prompt is already running on this session',
        )
      }
      const { text, images } = promptToRun(params.prompt)
      const controller = new AbortController()
      session.controller = controller

      // Notifications go out in order and all of them before the prompt's response: a client
      // may stop listening for a turn's updates once it has the stop reason.
      let outbox: Promise<void> = Promise.resolve()
      const send = (update: acp.SessionUpdate): void => {
        outbox = outbox
          .then(() => client.notify('session/update', { sessionId: params.sessionId, update }))
          .catch((error) => log.warn('acp', `session/update failed: ${error}`))
      }
      let streamed = false
      const events: AgentEventHandler = {
        onToken(token) {
          streamed = true
          send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: token } })
        },
        onThinkingToken(token) {
          send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: token } })
        },
        onToolCallStart(calls) {
          for (const call of calls) {
            send({
              sessionUpdate: 'tool_call',
              toolCallId: call.id,
              title: call.name,
              kind: toolKind(call.name),
              status: 'in_progress',
              rawInput: call.arguments,
            })
          }
        },
        onToolCallComplete(callId, _name, result) {
          send({
            sessionUpdate: 'tool_call_update',
            toolCallId: callId,
            status: result.success ? 'completed' : 'failed',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: result.output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) },
              },
            ],
          })
        },
      }

      try {
        const response = await session.loop.run(text, {
          events,
          signal: controller.signal,
          ...(images.length > 0 && { images }),
        })
        // A provider that does not stream still has an answer to show.
        if (!streamed && response.content) {
          send({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: response.content },
          })
        }
        await outbox
        if (response.aborted || controller.signal.aborted) return { stopReason: 'cancelled' }
        if (response.turnLimitReached) return { stopReason: 'max_turn_requests' }
        return { stopReason: 'end_turn' }
      } catch (error) {
        await outbox
        if (controller.signal.aborted) return { stopReason: 'cancelled' }
        log.error('acp', `Prompt failed on ${params.sessionId}`, error)
        throw error
      } finally {
        session.controller = undefined
      }
    })
    .onNotification('session/cancel', ({ params }) => {
      const session = sessions.get(params.sessionId)
      if (!session?.controller) return
      log.info('acp', `Cancelling ${params.sessionId}`)
      session.controller.abort('cancel')
      session.loop.interrupt()
    })
}
