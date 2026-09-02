import type { AgentLoop } from '../agent'
import type { ReplyBroker } from '../report/broker'
import { log } from '../util/logger'
import { deliver, runTurn } from './spine'
import type { ChatChannel } from './types'

/**
 * Telegram over the Bot API with long polling.
 *
 * No library: the Bot API is a handful of JSON-over-HTTPS calls and Bun's fetch covers it.
 * Long polling rather than a webhook because the whole point of egirl is that nothing has to
 * be reachable from the internet -- the bot pulls, the same way XMPP keeps a socket open.
 */

export interface TelegramConfig {
  token: string
  /** Numeric user IDs or @usernames allowed to message (empty = allow all). */
  allowedUsers: string[]
}

const API_BASE = 'https://api.telegram.org'
/** Seconds the server holds a getUpdates request open before returning an empty batch. */
const POLL_TIMEOUT_SEC = 30
/** Telegram rejects sendMessage bodies longer than this. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096

export interface TelegramUser {
  id: number
  username?: string
  is_bot?: boolean
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: { id: number; type: string }
  text?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

interface TelegramResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export function isAllowedTelegramUser(allowedUsers: string[], user: TelegramUser): boolean {
  if (allowedUsers.length === 0) return true
  const id = String(user.id)
  const username = user.username?.toLowerCase()
  return allowedUsers.some((entry) => {
    const normalized = entry.trim().replace(/^@/, '').toLowerCase()
    return normalized === id || (username !== undefined && normalized === username)
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

export class TelegramChannel implements ChatChannel {
  readonly name = 'telegram'
  private agent: AgentLoop
  private config: TelegramConfig
  private broker: ReplyBroker | undefined
  private fetchFn: FetchLike
  private offset = 0
  private abort: AbortController | undefined
  private polling: Promise<void> | undefined
  /** Most recent chat that talked to us -- where "self" notifications go. */
  private lastChatId: string | undefined

  constructor(agent: AgentLoop, config: TelegramConfig, broker?: ReplyBroker, fetchFn?: FetchLike) {
    this.agent = agent
    this.config = config
    this.broker = broker
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init))
  }

  async start(): Promise<void> {
    // Validate the token up front so a bad one fails start() instead of surfacing as an
    // endless stream of polling errors.
    const me = await this.call<TelegramUser>('getMe')
    log.info('telegram', `Connected as @${me.username ?? me.id}`)
    if (this.config.allowedUsers.length > 0) {
      log.info('telegram', `Allowed users: ${this.config.allowedUsers.join(', ')}`)
    } else {
      log.warn('telegram', 'All users allowed -- anyone who finds the bot can talk to it')
    }

    this.abort = new AbortController()
    this.polling = this.pollLoop(this.abort.signal)
  }

  async stop(): Promise<void> {
    log.info('telegram', 'Stopping Telegram polling...')
    this.abort?.abort()
    await this.polling
    this.polling = undefined
  }

  /** Outbound: send to a chat ID (used by the task runner and the report tool). */
  async send(to: string, body: string): Promise<void> {
    const target = !to || to === 'self' ? this.defaultTarget() : to
    if (!target) {
      log.warn(
        'telegram',
        'send called without a target: nobody has messaged the bot yet and allowed_users has no numeric ID',
      )
      return
    }
    await deliver(this.surface(target), body)
  }

  private surface(chatId: string) {
    return {
      maxLength: TELEGRAM_MAX_MESSAGE_LENGTH,
      send: async (chunk: string) => {
        await this.call('sendMessage', { chat_id: chatId, text: chunk })
      },
    }
  }

  private defaultTarget(): string | undefined {
    if (this.lastChatId) return this.lastChatId
    // A DM chat ID equals the user's ID, so a numeric allow-list entry is a reachable target
    // even before that user has said anything.
    return this.config.allowedUsers.find((u) => /^\d+$/.test(u.trim()))?.trim()
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let backoffMs = 1000
    while (!signal.aborted) {
      try {
        const updates = await this.call<TelegramUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ['message'] },
          signal,
        )
        backoffMs = 1000
        for (const update of updates) {
          // Acknowledge before handling: a crash mid-reply should not replay the message.
          this.offset = update.update_id + 1
          // Not awaited -- the poll must keep running while the agent works, or a reply to a
          // blocking report ask could never arrive.
          if (update.message) void this.handleMessage(update.message)
        }
      } catch (error) {
        if (signal.aborted) return
        log.error('telegram', 'Polling error:', error)
        await sleep(backoffMs, signal)
        backoffMs = Math.min(backoffMs * 2, 30_000)
      }
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const text = message.text?.trim()
    const from = message.from
    if (!text || !from || from.is_bot) return

    if (!isAllowedTelegramUser(this.config.allowedUsers, from)) {
      log.debug('telegram', `Ignoring message from non-allowed user: ${from.id}`)
      return
    }

    const chatId = String(message.chat.id)
    this.lastChatId = chatId
    const who = from.username ? `@${from.username}` : String(from.id)
    log.info('telegram', `Message from ${who}: ${text.slice(0, 100)}...`)

    await runTurn(
      this.agent,
      {
        channel: 'telegram',
        target: chatId,
        format: 'plain',
        ...this.surface(chatId),
        // There is no "stop typing" action; the indicator clears itself a few seconds after
        // the last refresh, or as soon as a message lands.
        typing: {
          refreshMs: 4000,
          set: async (on) => {
            if (on) await this.call('sendChatAction', { chat_id: chatId, action: 'typing' })
          },
        },
      },
      text,
      this.broker,
    )
  }

  private async call<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchFn(`${API_BASE}/bot${this.config.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal,
    })
    const json = (await res.json()) as TelegramResponse<T>
    if (!json.ok || json.result === undefined) {
      throw new Error(`Telegram ${method} failed: ${json.description ?? `HTTP ${res.status}`}`)
    }
    return json.result
  }
}

export function createTelegramChannel(
  agent: AgentLoop,
  config: TelegramConfig,
  broker?: ReplyBroker,
): TelegramChannel {
  return new TelegramChannel(agent, config, broker)
}
