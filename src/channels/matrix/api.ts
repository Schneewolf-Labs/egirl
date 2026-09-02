/**
 * The slice of the Matrix client-server API egirl needs, over plain fetch.
 *
 * Matrix is HTTPS + JSON; a bot that reads unencrypted rooms and posts text needs six
 * endpoints, and a full SDK would add more code than it removes. End-to-end encryption is
 * deliberately out of scope -- the bot's rooms must be unencrypted.
 */

export interface MatrixEvent {
  type: string
  sender?: string
  event_id?: string
  content?: Record<string, unknown>
}

export interface MatrixSyncResponse {
  next_batch: string
  rooms?: {
    join?: Record<string, { timeline?: { events?: MatrixEvent[] } }>
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>
  }
}

export interface MatrixApi {
  readonly homeserver: string
  login(user: string, password: string): Promise<{ userId: string; accessToken: string }>
  logout(): Promise<void>
  whoami(): Promise<string>
  sync(
    since: string | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<MatrixSyncResponse>
  join(roomIdOrAlias: string): Promise<void>
  sendText(roomId: string, body: string): Promise<void>
  setTyping(roomId: string, userId: string, isTyping: boolean): Promise<void>
}

export class MatrixApiError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string | undefined,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'MatrixApiError'
  }
}

// Events from the initial sync are history, not new messages; one per room is the smallest
// timeline Synapse honours, and the channel discards it anyway.
const INITIAL_FILTER = JSON.stringify({
  room: { timeline: { limit: 1 }, ephemeral: { types: [] } },
  presence: { types: [] },
})

const SYNC_FILTER = JSON.stringify({
  room: { timeline: { types: ['m.room.message'] }, ephemeral: { types: [] } },
  presence: { types: [] },
})

export function createMatrixApi(homeserver: string, accessToken?: string): MatrixApi {
  const base = homeserver.replace(/\/+$/, '')
  let token = accessToken

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`${base}/_matrix/client/v3${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = {}
    }
    if (!res.ok) {
      const err = (json ?? {}) as { errcode?: string; error?: string; retry_after_ms?: number }
      throw new MatrixApiError(
        res.status,
        err.errcode,
        `${method} ${path} -> ${res.status}${err.errcode ? ` ${err.errcode}` : ''}: ${err.error ?? text.slice(0, 200)}`,
        err.retry_after_ms,
      )
    }
    return json as T
  }

  return {
    homeserver: base,

    async login(user, password) {
      const res = await request<{ user_id: string; access_token: string }>('POST', '/login', {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password,
        initial_device_display_name: 'egirl',
      })
      token = res.access_token
      return { userId: res.user_id, accessToken: res.access_token }
    },

    async logout() {
      await request('POST', '/logout', {})
      token = undefined
    },

    async whoami() {
      const res = await request<{ user_id: string }>('GET', '/account/whoami')
      return res.user_id
    },

    async sync(since, timeoutMs, signal) {
      const params = new URLSearchParams({ filter: since ? SYNC_FILTER : INITIAL_FILTER })
      if (since) {
        params.set('since', since)
        params.set('timeout', String(timeoutMs))
      }
      return request<MatrixSyncResponse>('GET', `/sync?${params}`, undefined, signal)
    },

    async join(roomIdOrAlias) {
      await request('POST', `/join/${encodeURIComponent(roomIdOrAlias)}`, {})
    },

    async sendText(roomId, body) {
      const txnId = `egirl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      await request('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, {
        msgtype: 'm.text',
        body,
      })
    },

    async setTyping(roomId, userId, isTyping) {
      await request(
        'PUT',
        `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`,
        isTyping ? { typing: true, timeout: 30_000 } : { typing: false },
      )
    },
  }
}
