/**
 * Minimal contract for a communication channel.
 *
 * Each channel owns its transport (Discord WebSocket, XMPP stanza, Bot API poll, Matrix
 * sync) and hands inbound messages to the spine (spine.ts). No routing, no middleware.
 */
export interface Channel {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
}

/** Status of a card, mapped to a colour/icon by the renderer. */
export type CardStatus = 'ok' | 'warn' | 'error' | 'info'

/**
 * A transport-agnostic structured message — a status card. Built by code that already has the
 * structure (a finished task, a report, a CI/PR result) and rendered per surface: Discord makes
 * an embed, a surface without embeds falls back to markdown (see rich.ts). Keep it small and
 * portable; anything a plain chat cannot show degrades to text.
 */
export interface RichCard {
  title?: string
  /** Body text (markdown). */
  text?: string
  status?: CardStatus
  fields?: { name: string; value: string; inline?: boolean }[]
  url?: string
  footer?: string
}

/**
 * Outbound messaging — channels that can send messages without a user prompt.
 * Used by background tasks and the report tool to deliver results. `target` is
 * channel-specific (JID, chat ID, room ID); "self" means the channel's default target.
 */
export interface OutboundChannel {
  send(target: string, message: string): Promise<void>
  /**
   * Deliver a structured card, when the transport can (Discord embeds). Optional: callers go
   * through sendCardOrText (rich.ts), which falls back to send() with a markdown rendering.
   */
  sendCard?(target: string, card: RichCard): Promise<void>
}

/** A chat transport: something a human talks to egirl through, and that she can reach back on. */
export type ChatChannel = Channel & OutboundChannel
