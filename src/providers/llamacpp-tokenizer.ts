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
  private cache = new Map<string, number>()

  constructor(endpoint: string) {
    this.endpoint = endpoint.replace(/\/$/, '')
  }

  async countTokens(text: string): Promise<number> {
    const cached = this.cache.get(text)
    if (cached !== undefined) return cached

    try {
      const response = await fetch(`${this.endpoint}/tokenize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, add_special: false }),
        signal: AbortSignal.timeout(TOKENIZE_TIMEOUT_MS),
      })

      if (!response.ok) {
        log.debug(
          'tokenizer',
          `tokenize endpoint returned ${response.status}, falling back to estimate`,
        )
        return Math.ceil(text.length / 3.5)
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
      log.debug('tokenizer', 'tokenize request failed, falling back to estimate:', error)
      return Math.ceil(text.length / 3.5)
    }
  }
}

export function createLlamaCppTokenizer(endpoint: string): Tokenizer {
  return new LlamaCppTokenizer(endpoint)
}
