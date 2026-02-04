import type { ChatMessage } from '../providers/types'

export interface Session {
  id: string
  createdAt: Date
  lastActivityAt: Date
  messages: ChatMessage[]
  metadata: Record<string, unknown>
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map()

  create(id?: string): Session {
    const session: Session = {
      id: id ?? crypto.randomUUID(),
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messages: [],
      metadata: {},
    }

    this.sessions.set(session.id, session)
    return session
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  getOrCreate(id: string): Session {
    let session = this.sessions.get(id)
    if (!session) {
      session = this.create(id)
    }
    return session
  }

  update(id: string, updates: Partial<Session>): boolean {
    const session = this.sessions.get(id)
    if (!session) return false

    Object.assign(session, updates)
    session.lastActivityAt = new Date()
    return true
  }

  addMessage(id: string, message: ChatMessage): boolean {
    const session = this.sessions.get(id)
    if (!session) return false

    session.messages.push(message)
    session.lastActivityAt = new Date()
    return true
  }

  delete(id: string): boolean {
    return this.sessions.delete(id)
  }

  list(): Session[] {
    return Array.from(this.sessions.values())
  }

  cleanup(maxAge: number): number {
    const cutoff = Date.now() - maxAge
    let removed = 0

    for (const [id, session] of this.sessions) {
      if (session.lastActivityAt.getTime() < cutoff) {
        this.sessions.delete(id)
        removed++
      }
    }

    return removed
  }
}

export function createSessionManager(): SessionManager {
  return new SessionManager()
}
