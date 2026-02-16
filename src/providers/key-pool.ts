import { log } from '../util/logger'

/** State for a single API key in the pool */
interface KeyState {
  key: string
  cooldownUntil: number // epoch ms, 0 = available
  errorCount: number
  lastUsed: number
}

/** Cooldown parameters per error type */
interface CooldownPolicy {
  /** Base cooldown in ms. Actual = base * 5^min(errorCount, maxExponent) */
  baseMs: number
  /** Maximum exponent for exponential backoff */
  maxExponent: number
  /** Hard cap on cooldown duration */
  capMs: number
}

const COOLDOWN_POLICIES: Record<string, CooldownPolicy> = {
  rate_limit: { baseMs: 60_000, maxExponent: 3, capMs: 3_600_000 }, // 1m → 5m → 25m → 1h cap
  auth: { baseMs: 300_000, maxExponent: 2, capMs: 86_400_000 }, // 5m → 25m → 24h cap
  billing: { baseMs: 18_000_000, maxExponent: 1, capMs: 86_400_000 }, // 5h → 24h cap
  default: { baseMs: 30_000, maxExponent: 3, capMs: 900_000 }, // 30s → 150s → 750s → 15m cap
}

type ErrorKind = 'rate_limit' | 'auth' | 'billing' | 'default'

/**
 * Pool of API keys for a single provider with automatic rotation and cooldown.
 *
 * On error, the current key enters exponential cooldown. The pool rotates to
 * the next available key. If all keys are cooling down, returns the one with
 * the shortest remaining cooldown.
 */
export class KeyPool {
  private keys: KeyState[]
  private currentIndex: number = 0

  constructor(apiKeys: string[]) {
    if (apiKeys.length === 0) {
      throw new Error('KeyPool requires at least one API key')
    }
    this.keys = apiKeys.map((key) => ({
      key,
      cooldownUntil: 0,
      errorCount: 0,
      lastUsed: 0,
    }))
  }

  /** Get the next available API key. Prefers keys not in cooldown. */
  get(): string {
    const now = Date.now()

    // Try to find an available key starting from current index (round-robin)
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.currentIndex + i) % this.keys.length
      const state = this.keys[idx]
      if (!state) continue
      if (state.cooldownUntil <= now) {
        this.currentIndex = idx
        state.lastUsed = now
        return state.key
      }
    }

    // All keys are cooling down — pick the one that expires soonest
    let bestIdx = 0
    let bestExpiry = Number.MAX_SAFE_INTEGER
    for (let i = 0; i < this.keys.length; i++) {
      const state = this.keys[i]
      if (state && state.cooldownUntil < bestExpiry) {
        bestExpiry = state.cooldownUntil
        bestIdx = i
      }
    }

    this.currentIndex = bestIdx
    const state = this.keys[bestIdx]
    if (state) state.lastUsed = now
    log.warn(
      'key-pool',
      `All keys cooling down. Using key ${bestIdx + 1}/${this.keys.length} (cooldown expires in ${Math.round((bestExpiry - now) / 1000)}s)`,
    )
    return state?.key ?? this.keys[0]?.key ?? ''
  }

  /** Report a successful call — resets error count for the current key. */
  reportSuccess(): void {
    const state = this.keys[this.currentIndex]
    if (state) {
      state.errorCount = 0
      state.cooldownUntil = 0
    }
  }

  /** Report an error — puts the current key into cooldown and advances index. */
  reportError(kind: ErrorKind = 'default'): void {
    const state = this.keys[this.currentIndex]
    if (!state) return

    state.errorCount++
    const defaultPolicy: CooldownPolicy = { baseMs: 30_000, maxExponent: 3, capMs: 900_000 }
    const policy = COOLDOWN_POLICIES[kind] ?? defaultPolicy
    const backoff = Math.min(
      policy.capMs,
      policy.baseMs * 5 ** Math.min(state.errorCount - 1, policy.maxExponent),
    )
    state.cooldownUntil = Date.now() + backoff

    log.info(
      'key-pool',
      `Key ${this.currentIndex + 1}/${this.keys.length} cooling down for ${Math.round(backoff / 1000)}s (${kind}, errors: ${state.errorCount})`,
    )

    // Advance to next key
    if (this.keys.length > 1) {
      this.currentIndex = (this.currentIndex + 1) % this.keys.length
    }
  }

  /** Number of keys currently not in cooldown */
  availableCount(): number {
    const now = Date.now()
    return this.keys.filter((k) => k.cooldownUntil <= now).length
  }

  /** Total keys in the pool */
  size(): number {
    return this.keys.length
  }

  /** Classify an error message into an error kind for cooldown policy selection */
  static classifyError(errorMessage: string): ErrorKind {
    const msg = errorMessage.toLowerCase()

    if (msg.includes('429') || /rate[_ ]limit/i.test(msg) || /too many requests/i.test(msg)) {
      return 'rate_limit'
    }
    if (
      msg.includes('401') ||
      msg.includes('403') ||
      /invalid[_ ]?api[_ ]?key/i.test(msg) ||
      /unauthorized/i.test(msg) ||
      /authentication/i.test(msg)
    ) {
      return 'auth'
    }
    if (/billing/i.test(msg) || /payment/i.test(msg) || /insufficient.*funds/i.test(msg)) {
      return 'billing'
    }
    return 'default'
  }
}
