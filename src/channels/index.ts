export {
  ClaudeCodeChannel,
  type ClaudeCodeConfig,
  createClaudeCodeChannel,
  type TaskResult,
} from './claude-code'
export { CLIChannel, createCLIChannel } from './cli'
export {
  createDiscordChannel,
  DiscordChannel,
  type DiscordConfig,
  type InteractionHandler,
  type ReactionEvent,
  type ReactionHandler,
} from './discord'
export { createTelegramChannel, TelegramChannel, type TelegramConfig } from './telegram'
export type { Channel, ChannelFactory } from './types'
export { createXMPPChannel, XMPPChannel, type XMPPConfig } from './xmpp'
