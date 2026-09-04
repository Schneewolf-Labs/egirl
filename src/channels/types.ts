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

/**
 * Outbound messaging — channels that can send messages without a user prompt.
 * Used by background tasks and the report tool to deliver results. `target` is
 * channel-specific (JID, chat ID, room ID); "self" means the channel's default target.
 */
export interface OutboundChannel {
  send(target: string, message: string): Promise<void>
}

/** A chat transport: something a human talks to egirl through, and that she can reach back on. */
export type ChatChannel = Channel & OutboundChannel
