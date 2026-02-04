export interface ChannelMessage {
  id: string
  content: string
  userId: string
  userName: string
  channelId: string
  timestamp: Date
}

export interface ChannelResponse {
  content: string
  replyTo?: string
}

export interface Channel {
  name: string
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (message: ChannelMessage) => Promise<ChannelResponse>): void
}
