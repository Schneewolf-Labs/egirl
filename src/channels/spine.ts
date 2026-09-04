import type { AgentLoop } from '../agent'
import type { ReplyBroker } from '../report/broker'
import { handleCommand } from '../session/commands'
import { log } from '../util/logger'
import { splitMessage } from './chunk'
import { buildToolCallPrefix, createNarration, type NarrationFormat } from './narration'

/**
 * The shared half of every chat channel: what happens between "a human said something" and
 * "she replied". A transport (Discord, XMPP, Telegram, Matrix) owns its connection, its
 * allow-lists and how to parse a message out of its wire format; everything after that is
 * the same turn on every surface and lives here -- slash commands, pending report asks, the
 * typing indicator, tool-call narration, running the agent, chunking the reply to the transport's
 * cap, and turning a crash into an error message instead of silence.
 *
 * This is plumbing, not a registry. Channels are still hardcoded and constructed by name in
 * serve.ts; a new transport implements Channel + OutboundChannel and describes its surface
 * to runTurn. Nothing here discovers, negotiates or routes.
 */

/** One conversation on one transport, as the spine needs to see it. */
export interface Surface {
  /** Channel name, for the broker key and logs ("xmpp", "telegram", ...). */
  channel: string
  /** Conversation identity on that channel: bare JID, chat ID, room ID, Discord channel ID. */
  target: string
  /** Hard cap on one outbound message for this transport. */
  maxLength: number
  /** How the tool-call narration is rendered on this surface. */
  format: NarrationFormat
  /** Send one already-chunked piece of text. */
  send(chunk: string): Promise<void>
  /** Typing indicator primitive; the spine handles cadence and cleanup. Cosmetic, may reject. */
  typing?: { refreshMs: number; set(on: boolean): Promise<void> }
}

/**
 * Run one inbound message through the agent and deliver the reply.
 *
 * A slash command is answered here and never reaches the model -- checked first, so it
 * cannot be swallowed as the answer to a pending ask. A pending report ask on this surface
 * consumes the message as its answer -- the human is replying to the agent's question, not
 * starting a new turn. Never throws: a failed turn is reported back on the same surface.
 */
export async function runTurn(
  agent: AgentLoop,
  surface: Surface,
  text: string,
  broker?: ReplyBroker,
): Promise<void> {
  const command = await handleCommand(text, { agent })
  if (command.handled) {
    await deliver(surface, command.message ?? 'ok').catch(() => {})
    return
  }
  if (broker?.tryDeliver(surface.channel, surface.target, text)) return

  const stopTyping = keepTyping(surface)
  try {
    const { handler, state } = createNarration()
    const response = await agent.run(text, { events: handler })
    await deliver(surface, buildToolCallPrefix(state, surface.format) + response.content)
    log.debug(surface.channel, `Responded via ${response.provider}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(surface.channel, 'Error processing message:', error)
    await deliver(surface, `Error: ${message}`).catch(() => {})
  } finally {
    await stopTyping()
  }
}

/** Send text to a surface in transport-sized pieces. */
export async function deliver(
  surface: Pick<Surface, 'send' | 'maxLength'>,
  text: string,
): Promise<void> {
  const body = text.trim() || '(empty response)'
  for (const chunk of splitMessage(body, surface.maxLength)) {
    await surface.send(chunk)
  }
}

/**
 * Show "is typing…" until the returned function is called. Clients expire the indicator on
 * their own schedule (Telegram ~5s, Discord ~10s, XMPP ~30s), so it is refreshed on the
 * surface's cadence. A missing indicator is never worth failing a turn over.
 */
function keepTyping(surface: Surface): () => Promise<void> {
  const typing = surface.typing
  if (!typing) return async () => {}
  const set = (on: boolean) => typing.set(on).catch(() => {})
  void set(true)
  const timer = setInterval(() => void set(true), typing.refreshMs)
  return async () => {
    clearInterval(timer)
    await set(false)
  }
}
