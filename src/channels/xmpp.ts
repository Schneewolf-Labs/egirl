import { client, xml, type Client as XMPPClient } from '@xmpp/client'
import type { Element } from '@xmpp/xml'
import type { AgentLoop } from '../agent'
import type { AgentEventHandler } from '../agent/events'
import type { ToolCall } from '../providers/types'
import type { ToolResult } from '../tools/types'
import type { Channel } from './types'
import { log } from '../util/logger'

export interface XMPPConfig {
  service: string        // e.g. "xmpp://chat.example.com:5222" or "xmpps://..." for TLS
  domain: string         // XMPP domain (e.g. "example.com")
  username: string
  password: string
  resource?: string      // XMPP resource (default: "egirl")
  allowedJids: string[]  // Bare JIDs allowed to message (empty = allow all)
}

function formatToolCallsPlain(calls: ToolCall[]): string {
  return calls.map(call => {
    const args = Object.entries(call.arguments)
    if (args.length === 0) return `${call.name}()`
    if (args.length === 1) {
      const [key, val] = args[0]!
      const valStr = typeof val === 'string' ? val : JSON.stringify(val)
      if (valStr.length < 60) return `${call.name}(${key}: ${valStr})`
    }
    return `${call.name}(${JSON.stringify(call.arguments)})`
  }).join('\n')
}

function truncateResult(output: string, maxLen: number): string {
  const trimmed = output.trim()
  if (!trimmed) return ''
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.substring(0, maxLen) + '...'
}

interface XMPPEventState {
  entries: Array<{ call: string; result?: string }>
}

function createXMPPEventHandler(): { handler: AgentEventHandler; state: XMPPEventState } {
  const state: XMPPEventState = { entries: [] }

  const handler: AgentEventHandler = {
    onToolCallStart(calls: ToolCall[]) {
      for (const call of calls) {
        state.entries.push({ call: formatToolCallsPlain([call]) })
      }
    },

    onToolCallComplete(_callId: string, name: string, result: ToolResult) {
      const entry = state.entries.find(e => e.call.startsWith(name) && !e.result)
      if (entry) {
        const status = result.success ? 'ok' : 'err'
        const preview = truncateResult(result.output, 150)
        entry.result = `  -> ${status}${preview ? ': ' + preview : ''}`
      }
    },
  }

  return { handler, state }
}

function buildToolCallPrefix(state: XMPPEventState): string {
  if (state.entries.length === 0) return ''
  const lines = state.entries.map(e => {
    if (e.result) return `${e.call}\n${e.result}`
    return e.call
  })
  return lines.join('\n') + '\n\n'
}

function bareJid(fullJid: string): string {
  return fullJid.split('/')[0]!
}

export class XMPPChannel implements Channel {
  readonly name = 'xmpp'
  private xmpp: XMPPClient
  private agent: AgentLoop
  private config: XMPPConfig

  constructor(agent: AgentLoop, config: XMPPConfig) {
    this.agent = agent
    this.config = config

    this.xmpp = client({
      service: config.service,
      domain: config.domain,
      username: config.username,
      password: config.password,
      resource: config.resource ?? 'egirl',
    })
  }

  async start(): Promise<void> {
    this.xmpp.on('error', (err: unknown) => {
      log.error('xmpp', 'Connection error:', err)
    })

    this.xmpp.on('offline', () => {
      log.info('xmpp', 'Offline')
    })

    this.xmpp.on('stanza', async (stanza: Element) => {
      if (stanza.is('message') && stanza.attrs.type === 'chat') {
        await this.handleMessage(stanza)
      }
    })

    this.xmpp.on('online', async (address: { toString(): string }) => {
      log.info('xmpp', `Connected as ${address.toString()}`)
      if (this.config.allowedJids.length > 0) {
        log.info('xmpp', `Allowed JIDs: ${this.config.allowedJids.join(', ')}`)
      } else {
        log.info('xmpp', 'All JIDs allowed')
      }
      // Send initial presence to indicate availability
      await this.xmpp.send(xml('presence'))
    })

    log.info('xmpp', `Connecting to ${this.config.service}...`)
    await this.xmpp.start()
  }

  async stop(): Promise<void> {
    log.info('xmpp', 'Stopping XMPP client...')
    await this.xmpp.send(xml('presence', { type: 'unavailable' }))
    await this.xmpp.stop()
  }

  private async handleMessage(stanza: Element): Promise<void> {
    const from = stanza.attrs.from as string | undefined
    const body = stanza.getChildText('body')

    if (!from || !body?.trim()) return

    if (!this.isAllowed(from)) {
      log.debug('xmpp', `Ignoring message from non-allowed JID: ${from}`)
      return
    }

    log.info('xmpp', `Message from ${bareJid(from)}: ${body.slice(0, 100)}...`)

    try {
      const { handler, state } = createXMPPEventHandler()
      const response = await this.agent.run(body, { events: handler })

      const prefix = buildToolCallPrefix(state)
      const fullResponse = prefix + response.content

      await this.sendMessage(from, fullResponse)

      log.debug('xmpp', `Responded via ${response.provider}${response.escalated ? ' (escalated)' : ''}`)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      log.error('xmpp', 'Error processing message:', error)
      await this.sendMessage(from, `Error: ${errorMsg}`).catch(() => {})
    }
  }

  private async sendMessage(to: string, body: string): Promise<void> {
    const message = xml(
      'message',
      { type: 'chat', to },
      xml('body', {}, body),
    )
    await this.xmpp.send(message)
  }

  private isAllowed(fullJid: string): boolean {
    if (this.config.allowedJids.length === 0) return true
    const bare = bareJid(fullJid)
    return this.config.allowedJids.includes(bare)
  }
}

export function createXMPPChannel(agent: AgentLoop, config: XMPPConfig): XMPPChannel {
  return new XMPPChannel(agent, config)
}
