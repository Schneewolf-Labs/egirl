import type { AgentLoop } from '../agent'

/**
 * Minimal contract for a communication channel.
 *
 * Each channel owns its transport (Discord WebSocket, XMPP stanza, etc.)
 * and calls agent.run() internally. No routing, no middleware, no magic.
 */
export interface Channel {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
}

/**
 * Factory signature for channels that wrap AgentLoop.
 * Claude Code channel is intentionally excluded — it uses LLMProvider directly.
 */
export type ChannelFactory<C extends object> = (agent: AgentLoop, config: C) => Channel
