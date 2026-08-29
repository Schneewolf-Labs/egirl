import { log } from '../util/logger'
import type { Tokenizer } from './types'

const TOKENIZE_TIMEOUT_MS = 5_000
const MAX_CACHED_CONTENT_LENGTH = 100_000
const MAX_CACHE_ENTRIES = 2048

/**
 * Tokenizer backed by llama.cpp's /tokenize endpoint.
 * Caches results by content string so repeated calls (system prompt, tool defs,
 * unchanged messages between turns) are free.
 * Falls back to char-ratio estimation on network/server errors.
 */
export class LlamaCppTokenizer implements Tokenizer {
  private endpoint: string
  private apiKey: string | undefined
  private cache = new Map<string, number>()
  private warnedFallback = false

  constructor(endpoint: string, apiKey?: string) {
    this.endpoint = endpoint.replace(/\/$/, '')
    this.apiKey = apiKey
  }

  /**
   * Estimation is ~7% *below* real llama.cpp counts on agentic transcripts — enough that a
   * budget trimmed against estimates overflows a server limit sized near the config value.
   * Silent per-call debug logging hid exactly that (a keyed server 401'd /tokenize and every
   * count quietly degraded), so the first fallback warns loudly.
   */
  private fallback(reason: string, text: string): number {
    if (!this.warnedFallback) {
      this.warnedFallback = true
      log.warn('tokenizer', `${reason} — token counts degraded to char-ratio estimates`)
    }
    return Math.ceil(text.length / 3.5)
  }

  async countTokens(text: string): Promise<number> {
    const cached = this.cache.get(text)
    if (cached !== undefined) return cached

    try {
      const response = await fetch(`${this.endpoint}/tokenize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
        },
        body: JSON.stringify({ content: text, add_special: false }),
        signal: AbortSignal.timeout(TOKENIZE_TIMEOUT_MS),
      })

      if (!response.ok) {
        return this.fallback(`tokenize endpoint returned ${response.status}`, text)
      }

      const data = (await response.json()) as { tokens: number[] }
      const count = data.tokens.length

      // Cache if content isn't huge (avoids holding large strings as map keys)
      if (text.length <= MAX_CACHED_CONTENT_LENGTH) {
        if (this.cache.size >= MAX_CACHE_ENTRIES) {
          const firstKey = this.cache.keys().next().value
          if (firstKey !== undefined) this.cache.delete(firstKey)
        }
        this.cache.set(text, count)
      }

      return count
    } catch (error) {
      return this.fallback(`tokenize request failed (${error})`, text)
    }
  }
}

export function createLlamaCppTokenizer(endpoint: string, apiKey?: string): Tokenizer {
  return new LlamaCppTokenizer(endpoint, apiKey)
}
