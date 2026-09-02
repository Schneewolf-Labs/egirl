import { client, type Client as XMPPClient, xml } from '@xmpp/client'
import type { Element } from '@xmpp/xml'
import type { AgentLoop } from '../agent'
import type { ReplyBroker } from '../report/broker'
import { log } from '../util/logger'
import { deliver, runTurn } from './spine'
import type { ChatChannel } from './types'

export interface XMPPConfig {
  service: string // e.g. "xmpp://chat.example.com:5222" or "xmpps://..." for TLS
  domain: string // XMPP domain (e.g. "example.com")
  username: string
  password: string
  resource?: string // XMPP resource (default: "egirl")
  allowedJids: string[] // Bare JIDs allowed to message (empty = allow all)
}

function bareJid(fullJid: string): string {
  return fullJid.split('/')[0] ?? fullJid
}

// XEP-0085 chat states: lets the client show "is typing…" while the agent thinks, so a long
// turn reads as activity instead of dead air.
const CHAT_STATES_NS = 'http://jabber.org/protocol/chatstates'
// XMPP has no fixed cap, but servers commonly reject stanzas past a few tens of KB.
const MAX_MESSAGE_LENGTH = 8000

export class XMPPChannel implements ChatChannel {
  readonly name = 'xmpp'
  private xmpp: XMPPClient
  private agent: AgentLoop
  private config: XMPPConfig
  private broker: ReplyBroker | undefined

  constructor(agent: AgentLoop, config: XMPPConfig, broker?: ReplyBroker) {
    this.agent = agent
    this.config = config
    this.broker = broker

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
    // Only announce departure if we ever arrived. Sending presence on a client that never came
    // online rejects, and that rejection used to skip the stop() below entirely -- leaving the
    // client's reconnect loop running and logging a connection error every second forever, for
    // a failure (a self-signed certificate, say) that will never resolve on its own.
    try {
      if (this.xmpp.status === 'online') {
        await this.xmpp.send(xml('presence', { type: 'unavailable' }))
      }
    } catch {
      // A best-effort goodbye is not worth failing a shutdown over.
    }
    await this.xmpp.stop()
  }

  /** Outbound: send a message to a JID (used by the task runner and the report tool). */
  async send(to: string, body: string): Promise<void> {
    if (!to || to === 'self') {
      // Fall back to the first allowed JID if configured
      const fallback = this.config.allowedJids[0]
      if (!fallback) {
        log.warn('xmpp', 'send called without a target and no allowed_jids configured')
        return
      }
      to = fallback
    }
    await deliver(this.surface(to), body)
  }

  private surface(jid: string) {
    return {
      maxLength: MAX_MESSAGE_LENGTH,
      send: (chunk: string) => this.sendMessage(jid, chunk),
    }
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

    // Reply to the full JID (the resource that spoke); the conversation is keyed by bare JID.
    await runTurn(
      this.agent,
      {
        channel: 'xmpp',
        target: bareJid(from),
        format: 'plain',
        ...this.surface(from),
        typing: {
          refreshMs: 15_000,
          set: (on) => this.sendChatState(from, on ? 'composing' : 'active'),
        },
      },
      body,
      this.broker,
    )
  }

  /** XEP-0085 chat state (composing/active/paused). */
  private async sendChatState(to: string, state: 'composing' | 'active' | 'paused'): Promise<void> {
    if (this.xmpp.status !== 'online') return
    await this.xmpp.send(
      xml('message', { type: 'chat', to }, xml(state, { xmlns: CHAT_STATES_NS })),
    )
  }

  private async sendMessage(to: string, body: string): Promise<void> {
    const message = xml('message', { type: 'chat', to }, xml('body', {}, body))
    await this.xmpp.send(message)
  }

  private isAllowed(fullJid: string): boolean {
    if (this.config.allowedJids.length === 0) return true
    const bare = bareJid(fullJid)
    return this.config.allowedJids.includes(bare)
  }
}

export function createXMPPChannel(
  agent: AgentLoop,
  config: XMPPConfig,
  broker?: ReplyBroker,
): XMPPChannel {
  return new XMPPChannel(agent, config, broker)
}
