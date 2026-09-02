import type { AgentLoop } from '../agent'
import type { ReplyBroker } from '../report/broker'
import { log } from '../util/logger'
import { splitMessage } from './discord/formatting'
import { createMatrixApi, type MatrixApi, MatrixApiError, type MatrixEvent } from './matrix/api'
import { buildToolCallPrefix, createPlainEventHandler } from './plain-events'
import type { Channel } from './types'

export interface MatrixConfig {
  homeserver: string // e.g. "https://matrix.example.com"
  accessToken?: string // Pre-provisioned token; takes precedence over username/password
  username?: string // Localpart or full MXID, for password login
  password?: string
  allowedUsers: string[] // MXIDs allowed to message (empty = allow all)
  allowedRooms: string[] // Room IDs the bot answers in (empty = any room it is in)
  autoJoin: boolean // Accept invites from allowed users
}

// Matrix caps an event at 64 KiB; well under that keeps long tool output readable.
const MAX_MESSAGE_LENGTH = 4000
const SYNC_TIMEOUT_MS = 30_000
const SYNC_RETRY_MS = 5_000

/**
 * Element (and the spec) prefix a reply's body with a quoted fallback of the message being
 * replied to. The agent only wants what the human typed.
 */
export function stripReplyFallback(body: string): string {
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length && lines[i]?.startsWith('> ')) i++
  if (i === 0) return body
  while (i < lines.length && lines[i]?.trim() === '') i++
  return lines.slice(i).join('\n')
}

export function extractText(event: MatrixEvent): string | undefined {
  if (event.type !== 'm.room.message') return undefined
  const content = event.content ?? {}
  if (content.msgtype !== 'm.text' && content.msgtype !== 'm.notice') return undefined
  const relates = content['m.relates_to'] as Record<string, unknown> | undefined
  // Edits redeliver the original with m.new_content; answering both would double-post.
  if (relates?.rel_type === 'm.replace') return undefined
  const body = typeof content.body === 'string' ? content.body : ''
  const text = relates?.['m.in_reply_to'] ? stripReplyFallback(body) : body
  return text.trim() || undefined
}

export class MatrixChannel implements Channel {
  readonly name = 'matrix'
  private api: MatrixApi
  private agent: AgentLoop
  private config: MatrixConfig
  private broker: ReplyBroker | undefined
  private userId = ''
  private abort: AbortController | undefined
  private syncLoop: Promise<void> | undefined
  private isPasswordSession = false
  /** Where a "self"-targeted notification goes when no allowed_rooms are configured. */
  private lastRoomId: string | undefined

  constructor(agent: AgentLoop, config: MatrixConfig, broker?: ReplyBroker, api?: MatrixApi) {
    this.agent = agent
    this.config = config
    this.broker = broker
    this.api = api ?? createMatrixApi(config.homeserver, config.accessToken)
  }

  async start(): Promise<void> {
    log.info('matrix', `Connecting to ${this.config.homeserver}...`)
    if (this.config.accessToken) {
      this.userId = await this.api.whoami()
    } else if (this.config.username && this.config.password) {
      const session = await this.api.login(this.config.username, this.config.password)
      this.userId = session.userId
      this.isPasswordSession = true
    } else {
      throw new Error('Matrix needs MATRIX_ACCESS_TOKEN or MATRIX_USERNAME + MATRIX_PASSWORD')
    }
    log.info('matrix', `Connected as ${this.userId}`)
    if (this.config.allowedUsers.length > 0) {
      log.info('matrix', `Allowed users: ${this.config.allowedUsers.join(', ')}`)
    } else {
      log.info('matrix', 'All users allowed')
    }

    this.abort = new AbortController()
    // The initial sync is history; keep only its cursor (and any invites waiting for us).
    const initial = await this.api.sync(undefined, SYNC_TIMEOUT_MS, this.abort.signal)
    await this.handleInvites(initial.rooms?.invite)
    this.syncLoop = this.runSyncLoop(initial.next_batch, this.abort.signal)
  }

  async stop(): Promise<void> {
    log.info('matrix', 'Stopping Matrix client...')
    this.abort?.abort()
    await this.syncLoop?.catch(() => {})
    if (this.isPasswordSession) {
      // A password login minted a device; drop it rather than leave one per restart.
      await this.api.logout().catch(() => {})
    }
  }

  /** Outbound: post to a room (used by the task runner and the report tool). */
  async sendTo(to: string, body: string): Promise<void> {
    if (!to || to === 'self') {
      const fallback = this.config.allowedRooms[0] ?? this.lastRoomId
      if (!fallback) {
        log.warn('matrix', 'sendTo called without a target, no allowed_rooms and no room seen yet')
        return
      }
      to = fallback
    }
    for (const chunk of splitMessage(body, MAX_MESSAGE_LENGTH)) {
      await this.api.sendText(to, chunk)
    }
  }

  private async runSyncLoop(since: string, signal: AbortSignal): Promise<void> {
    let cursor = since
    while (!signal.aborted) {
      try {
        const res = await this.api.sync(cursor, SYNC_TIMEOUT_MS, signal)
        cursor = res.next_batch
        await this.handleInvites(res.rooms?.invite)
        for (const [roomId, room] of Object.entries(res.rooms?.join ?? {})) {
          for (const event of room.timeline?.events ?? []) {
            // Not awaited: a turn may park on the broker waiting for the next message from
            // this very room, and that message only arrives if sync keeps going.
            void this.handleEvent(roomId, event).catch((error) => {
              log.error('matrix', 'Error handling event:', error)
            })
          }
        }
      } catch (error) {
        if (signal.aborted) return
        const wait =
          error instanceof MatrixApiError && error.retryAfterMs ? error.retryAfterMs : SYNC_RETRY_MS
        log.error('matrix', `Sync failed, retrying in ${wait}ms:`, error)
        await Bun.sleep(wait)
      }
    }
  }

  private async handleInvites(
    invites: Record<string, { invite_state?: { events?: MatrixEvent[] } }> | undefined,
  ): Promise<void> {
    if (!invites || !this.config.autoJoin) return
    for (const [roomId, invite] of Object.entries(invites)) {
      const member = invite.invite_state?.events?.find(
        (e) => e.type === 'm.room.member' && e.content?.membership === 'invite',
      )
      const inviter = member?.sender
      if (!inviter || !this.isAllowedUser(inviter) || !this.isAllowedRoom(roomId)) {
        log.debug('matrix', `Ignoring invite to ${roomId} from ${inviter ?? 'unknown'}`)
        continue
      }
      try {
        await this.api.join(roomId)
        log.info('matrix', `Joined ${roomId} (invited by ${inviter})`)
      } catch (error) {
        log.error('matrix', `Failed to join ${roomId}:`, error)
      }
    }
  }

  async handleEvent(roomId: string, event: MatrixEvent): Promise<void> {
    const sender = event.sender
    const text = extractText(event)
    if (!sender || !text || sender === this.userId) return

    if (!this.isAllowedUser(sender) || !this.isAllowedRoom(roomId)) {
      log.debug('matrix', `Ignoring message from ${sender} in ${roomId}`)
      return
    }

    this.lastRoomId = roomId
    log.info('matrix', `Message from ${sender} in ${roomId}: ${text.slice(0, 100)}...`)

    // A pending report ask on this room consumes the message as its answer.
    if (this.broker?.tryDeliver('matrix', roomId, text)) return

    const typing = setInterval(() => {
      this.api.setTyping(roomId, this.userId, true).catch(() => {})
    }, 20_000)
    try {
      await this.api.setTyping(roomId, this.userId, true).catch(() => {})
      const { handler, state } = createPlainEventHandler()
      const response = await this.agent.run(text, { events: handler })
      await this.sendTo(roomId, buildToolCallPrefix(state) + response.content)
      log.debug('matrix', `Responded via ${response.provider}`)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      log.error('matrix', 'Error processing message:', error)
      await this.sendTo(roomId, `Error: ${errorMsg}`).catch(() => {})
    } finally {
      clearInterval(typing)
      await this.api.setTyping(roomId, this.userId, false).catch(() => {})
    }
  }

  private isAllowedUser(userId: string): boolean {
    return this.config.allowedUsers.length === 0 || this.config.allowedUsers.includes(userId)
  }

  private isAllowedRoom(roomId: string): boolean {
    return this.config.allowedRooms.length === 0 || this.config.allowedRooms.includes(roomId)
  }
}

export function createMatrixChannel(
  agent: AgentLoop,
  config: MatrixConfig,
  broker?: ReplyBroker,
): MatrixChannel {
  return new MatrixChannel(agent, config, broker)
}
