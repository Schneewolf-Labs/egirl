export { type Channel, type ChannelFactory } from './types'
export { CLIChannel, createCLIChannel } from './cli'
export { ClaudeCodeChannel, createClaudeCodeChannel, type ClaudeCodeConfig, type TaskResult } from './claude-code'
export {
  DiscordChannel,
  createDiscordChannel,
  type DiscordConfig,
  type ReactionEvent,
  type ReactionHandler,
  type InteractionHandler,
} from './discord'
export { XMPPChannel, createXMPPChannel, type XMPPConfig } from './xmpp'
