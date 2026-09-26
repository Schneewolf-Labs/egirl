/**
 * The Wald A2A mailbox, reached through the MCP tools already connected for the registry.
 *
 * A mailbox is how work gets handed to an agent that is not up right now, or that is not an
 * egirl at all. Wald stores the message; the recipient polls for it. Nothing here pushes,
 * listens or retries: Wald's own contract is at-least-once (a read message stays unread until
 * acked), and that is the only delivery guarantee this relies on.
 *
 * Wald stays a tool. This file is three thin wrappers over its MCP tools, not a queue.
 */

import type { Tool } from '../tools/types'
import { errorMessage } from '../util/errors'
import { parseMcpRows } from './discovery'

/** One inbox row as Wald returns it. */
export interface MailMessage {
  id: string
  thread_id: string
  /** Sender slug. Absent on a Wald too old to name senders — such a message is unattributable. */
  from_agent?: string
  role: string
  content: string
  status: string
  created_at: string
}

export type MailResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface MailboxClient {
  send(opts: {
    to: string
    content: string
    role: 'request' | 'response' | 'notify'
    threadId?: string
  }): Promise<MailResult<{ messageId: string; threadId: string }>>
  readInbox(limit?: number): Promise<MailResult<MailMessage[]>>
  ack(messageIds: string[]): Promise<MailResult<number>>
}

export interface MailboxClientOptions {
  /** Resolve a connected tool by its full name; the registry's are `<server>_<tool>`. */
  lookup: (name: string) => Tool | undefined
  /** MCP server name Wald is configured under. */
  registry: string
  /**
   * This instance's slug in the registry. Sent as `from_agent` / `agent`, which Wald ignores
   * when its authentication is on (the token decides) and requires when it is off.
   */
  selfName: string
}

function isMailMessage(row: unknown): row is MailMessage {
  if (!row || typeof row !== 'object') return false
  const r = row as Record<string, unknown>
  return (
    typeof r.id === 'string' && typeof r.thread_id === 'string' && typeof r.content === 'string'
  )
}

export function createMailboxClient(opts: MailboxClientOptions): MailboxClient {
  // Resolved per call rather than captured, so a registry that was down at startup and
  // connected later is picked up without a restart.
  const call = async (
    name: string,
    params: Record<string, unknown>,
  ): Promise<MailResult<string>> => {
    const tool = opts.lookup(`${opts.registry}_${name}`)
    if (!tool) {
      return { ok: false, error: `Mailbox tool ${opts.registry}_${name} is not connected` }
    }
    try {
      const result = await tool.execute(params, '/tmp')
      if (!result.success) return { ok: false, error: result.output }
      return { ok: true, value: String(result.output) }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  const parseOne = (output: string): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(output)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }

  return {
    async send({ to, content, role, threadId }) {
      const r = await call('send_agent_message', {
        to_agent: to,
        content,
        role,
        from_agent: opts.selfName,
        ...(threadId && { thread_id: threadId }),
      })
      if (!r.ok) return r
      const body = parseOne(r.value)
      if (typeof body?.message_id !== 'string' || typeof body.thread_id !== 'string') {
        return { ok: false, error: `Unexpected send_agent_message reply: ${r.value.slice(0, 300)}` }
      }
      return { ok: true, value: { messageId: body.message_id, threadId: body.thread_id } }
    },

    async readInbox(limit = 20) {
      const r = await call('read_inbox', { unread_only: true, limit, agent: opts.selfName })
      if (!r.ok) return r
      return { ok: true, value: parseMcpRows(r.value).filter(isMailMessage) }
    },

    async ack(messageIds) {
      if (messageIds.length === 0) return { ok: true, value: 0 }
      const r = await call('ack_messages', { message_ids: messageIds, agent: opts.selfName })
      if (!r.ok) return r
      const acknowledged = parseOne(r.value)?.acknowledged
      return { ok: true, value: typeof acknowledged === 'number' ? acknowledged : 0 }
    },
  }
}
