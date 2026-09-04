/**
 * The state a conversation has that a single agent run does not.
 *
 * The CLI is currently modal: it either listens or works. While a turn is running there is no
 * input, no way to interrupt, and no way to change anything -- so hitting the turn cap means
 * restarting the process, and typing while it thinks means losing what you typed.
 *
 * All of that is one missing piece rather than four features: something that owns the queue, the
 * abort handle and the mutable settings, and stays alive across turns. The renderer then becomes
 * thin, which is what lets a terminal and a browser show the same session without either being
 * the source of truth.
 */

export type RunMode = 'ask' | 'auto'

export interface SessionSettings {
  /** Turn cap for a single run. Raising it mid-session is the whole point of it living here. */
  maxTurns: number
  /** `auto` stops asking to continue when a run hits its cap. */
  mode: RunMode
  /** Show the model's reasoning inline with tool calls. */
  showReasoning: boolean
}

export const DEFAULT_SETTINGS: SessionSettings = {
  maxTurns: 10,
  mode: 'ask',
  showReasoning: true,
}

export interface QueuedMessage {
  text: string
  at: number
}

/**
 * Owns everything that outlives a single turn.
 *
 * Deliberately free of I/O: no stdin, no writing, no agent. That is what makes it testable, and
 * what stops a second renderer having to reimplement the rules it encodes.
 */
export class SessionController {
  private settings: SessionSettings
  private queue: QueuedMessage[] = []
  private controller?: AbortController
  private running = false
  private interruptedAt?: number

  constructor(initial: Partial<SessionSettings> = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...initial }
  }

  // --- settings ---------------------------------------------------------------

  get(): Readonly<SessionSettings> {
    return this.settings
  }

  /**
   * Apply a settings change, returning what to tell the user.
   *
   * Returns a message rather than printing one so the same call works from a terminal, an HTTP
   * handler, or a test.
   */
  set<K extends keyof SessionSettings>(key: K, value: SessionSettings[K]): string {
    const before = this.settings[key]
    this.settings[key] = value
    return `${key}: ${String(before)} → ${String(value)}`
  }

  toggleMode(): string {
    return this.set('mode', this.settings.mode === 'auto' ? 'ask' : 'auto')
  }

  // --- queue ------------------------------------------------------------------

  /**
   * Accept input while a turn is in flight.
   *
   * Queued rather than interleaved: sending a second message into a run that is already deciding
   * what to do produces two agents arguing inside one context. Waiting for the turn boundary
   * keeps the conversation a conversation.
   */
  enqueue(text: string): void {
    const trimmed = text.trim()
    if (trimmed) this.queue.push({ text: trimmed, at: Date.now() })
  }

  /**
   * Take everything queued, joined into one message.
   *
   * Three quick thoughts typed during a long turn are one intent, not three turns. Delivering
   * them separately would make the agent answer the first and rediscover the rest afterwards.
   */
  drain(): string | undefined {
    if (this.queue.length === 0) return undefined
    const text = this.queue.map((q) => q.text).join('\n')
    this.queue = []
    return text
  }

  peek(): readonly QueuedMessage[] {
    return this.queue
  }

  clearQueue(): number {
    const n = this.queue.length
    this.queue = []
    return n
  }

  // --- run lifecycle ----------------------------------------------------------

  /** Begin a turn, producing the signal to hand the agent. */
  begin(): AbortSignal {
    this.controller = new AbortController()
    this.running = true
    this.interruptedAt = undefined
    return this.controller.signal
  }

  end(): void {
    this.running = false
    this.controller = undefined
  }

  get isRunning(): boolean {
    return this.running
  }

  /**
   * Abandon the current turn.
   *
   * Returns false when nothing is running, so a stray keypress at the prompt does not read as a
   * successful interrupt. The agent loop already checks its signal between turns and around
   * inference, so this stops at the next boundary rather than killing the process.
   */
  interrupt(): boolean {
    if (!this.running || !this.controller) return false
    this.controller.abort()
    this.interruptedAt = Date.now()
    return true
  }

  get wasInterrupted(): boolean {
    return this.interruptedAt !== undefined
  }

  /**
   * Whether a run that hit its turn cap should keep going.
   *
   * In `auto` it continues; in `ask` the caller prompts. Keeping the rule here rather than in the
   * renderer means a browser and a terminal cannot drift into disagreeing about it.
   */
  shouldContinuePastCap(): boolean {
    return this.settings.mode === 'auto'
  }
}
