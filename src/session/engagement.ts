/**
 * Transport-agnostic engagement policy: given the messages arriving on one conversation,
 * decide WHEN she should take a turn. This is the half of "passive monitoring" that has
 * nothing to do with Discord — no client, no gateway, no message objects — so a second
 * surface (a custom app, the console, a future transport) can reuse the exact same rules by
 * feeding it the same normalized signal.
 *
 * It answers one question — engage on this message or stay quiet — from three deterministic
 * inputs, in priority order:
 *
 *   1. Addressed. The transport already knows this was aimed at her (an @mention, a reply to
 *      one of her messages). Always engages.
 *   2. Wake word. The text names her ("juno ..."). Engages, and matching is by whole word by
 *      default so "junonium" does not trip "juno".
 *   3. Conversation window. She answered recently, so the next messages are almost certainly
 *      still talking to her and need no fresh wake word. Every engagement (re)opens the window;
 *      silence longer than the window closes it and the wake word is required again.
 *
 * With `requireWake = false` a conversation that is hers alone engages on anything (she reads
 * the channel in batches rather than waiting to be named) — the window then only governs how
 * engagement is reported, not whether it happens.
 *
 * Deliberately NOT here: batching/debounce (that is MessageBatcher's job and already generic)
 * and any model call. The old relevance check asked a model "should I butt in?" on every batch,
 * which is non-deterministic and, in a channel that is already hers, just latency. This replaces
 * that judgement with rules the caller — and the user — can predict.
 */

/** How a conversation decides to engage. Mapped from a transport's config (e.g. TOML keys). */
export interface EngagementConfig {
  /** Names that wake her when they appear in the text. Empty disables wake-word matching. */
  wakeWords: string[]
  /**
   * How long after the last engagement she keeps answering without a fresh wake word, in ms.
   * `0` (or less) means every turn must be addressed or name her — no open conversation.
   */
  conversationWindowMs: number
  /**
   * `true`: stay silent until addressed or named (then the window carries the conversation).
   * `false`: engage on any message — for a channel that is hers alone, where everything said
   * is for her anyway.
   */
  requireWake: boolean
  /**
   * Match a wake word only as a whole word (`\bjuno\b`), not as a substring. Default `true`.
   */
  matchWholeWord?: boolean
}

/** Why a message engaged (or, for `idle`, why it did not). Useful for logs and tests. */
export type EngagementReason = 'addressed' | 'wake' | 'window' | 'open' | 'idle'

export interface EngagementDecision {
  engage: boolean
  reason: EngagementReason
}

/** One inbound message, reduced to what the policy needs. The transport fills this in. */
export interface InboundSignal {
  /** Opaque conversation key (Discord channel id, room id, app session id, …). */
  conversationId: string
  /** The message text, already stripped of transport decoration (e.g. a leading @mention). */
  text: string
  /** The transport knows this was aimed at her (an @mention, a reply to her). Always engages. */
  addressed?: boolean
  /** Event time in ms; defaults to now. Injectable so the window is testable without waiting. */
  at?: number
}

/** True if any wake word appears in `text`. Case-insensitive; whole-word unless told otherwise. */
export function containsWakeWord(
  text: string,
  wakeWords: string[],
  matchWholeWord = true,
): boolean {
  if (wakeWords.length === 0 || !text) return false
  const haystack = text.toLowerCase()
  for (const raw of wakeWords) {
    const word = raw.trim().toLowerCase()
    if (!word) continue
    if (!matchWholeWord) {
      if (haystack.includes(word)) return true
      continue
    }
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(word)}(?:$|[^\\p{L}\\p{N}_])`, 'u')
    if (re.test(haystack)) return true
  }
  return false
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Per-conversation engagement state. One instance serves every conversation on a surface; the
 * window is tracked per `conversationId`, so parallel conversations never leak into each other.
 */
export class EngagementTracker {
  private readonly wakeWords: string[]
  private readonly windowMs: number
  private readonly requireWake: boolean
  private readonly matchWholeWord: boolean
  /** conversationId -> timestamp (ms) the open window lapses at. Absent/past means closed. */
  private readonly activeUntil = new Map<string, number>()

  constructor(config: EngagementConfig) {
    this.wakeWords = config.wakeWords.filter((w) => w.trim().length > 0)
    this.windowMs = Math.max(0, config.conversationWindowMs)
    this.requireWake = config.requireWake
    this.matchWholeWord = config.matchWholeWord ?? true
  }

  /**
   * Decide whether this message engages her, and (as a side effect) open or extend the window
   * when it does. Returns `idle` without touching state when it does not.
   */
  consider(signal: InboundSignal): EngagementDecision {
    const at = signal.at ?? Date.now()

    if (signal.addressed === true) return this.engage(signal.conversationId, at, 'addressed')
    if (containsWakeWord(signal.text, this.wakeWords, this.matchWholeWord)) {
      return this.engage(signal.conversationId, at, 'wake')
    }
    if (this.isEngaged(signal.conversationId, at)) {
      return this.engage(signal.conversationId, at, 'window')
    }
    if (!this.requireWake) return this.engage(signal.conversationId, at, 'open')

    return { engage: false, reason: 'idle' }
  }

  /** (Re)open the window, e.g. when she finishes a reply so the next messages carry on freely. */
  noteReply(conversationId: string, at: number = Date.now()): void {
    if (this.windowMs > 0) this.activeUntil.set(conversationId, at + this.windowMs)
  }

  /** True while the conversation is inside an open window. */
  isEngaged(conversationId: string, at: number = Date.now()): boolean {
    const until = this.activeUntil.get(conversationId)
    return until !== undefined && until > at
  }

  /** Forget a conversation's window (all of them when no id is given). */
  reset(conversationId?: string): void {
    if (conversationId === undefined) this.activeUntil.clear()
    else this.activeUntil.delete(conversationId)
  }

  private engage(conversationId: string, at: number, reason: EngagementReason): EngagementDecision {
    if (this.windowMs > 0) this.activeUntil.set(conversationId, at + this.windowMs)
    return { engage: true, reason }
  }
}
