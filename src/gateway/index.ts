// Gateway module - WebSocket server for external connections
// This is a stub for future implementation

export * from './protocol'
export { SessionManager, createSessionManager, type Session } from './session'

import { log } from '../utils/logger'

export interface GatewayOptions {
  port: number
  host?: string
}

export class Gateway {
  private options: GatewayOptions
  private server: unknown = null

  constructor(options: GatewayOptions) {
    this.options = options
  }

  async start(): Promise<void> {
    log.info('gateway', `Gateway starting on ${this.options.host ?? '0.0.0.0'}:${this.options.port}`)
    // TODO: Implement WebSocket server
    log.warn('gateway', 'Gateway not yet implemented')
  }

  async stop(): Promise<void> {
    log.info('gateway', 'Gateway stopping')
    // TODO: Implement shutdown
  }
}

export function createGateway(options: GatewayOptions): Gateway {
  return new Gateway(options)
}
