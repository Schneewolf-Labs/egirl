/**
 * Stale-timeout floors for reasoning model families.
 *
 * The names tested are the ACTUAL model strings this house runs -- the failure this guards
 * against was a real one (Zero's Qwen3.8 killed mid-think at the default timeout), so the
 * matching has to hold for real GGUF naming, not idealized slugs.
 */

import { describe, expect, test } from 'bun:test'
import { reasoningStaleFloorMs, withReasoningFloor } from '../../src/providers/reasoning-floors'

describe('family matching against real model names', () => {
  test('the models this house actually runs get the qwen3 floor', () => {
    for (const name of [
      'huihui-qwen3.8-27b-abliterated-q8_0',
      'wichtel-qwen3.6-27b-q8_0',
      'compactor-qwen3.5-4b',
      'Qwen3-32B',
    ]) {
      expect(reasoningStaleFloorMs(name)).toBe(180_000)
    }
  })

  test('qwen2.5 is not qwen3', () => {
    // Prefix must bind to the token, not fuzzy-match the family digit.
    expect(reasoningStaleFloorMs('qwen2.5-7b-instruct')).toBe(0)
  })

  test('r1 distills get the deep-reasoning floor', () => {
    expect(reasoningStaleFloorMs('DeepSeek-R1-Distill-Qwen-32B')).toBe(600_000)
  })

  test('a slug never matches mid-token', () => {
    // "warden3" contains no qwen3 token; substring matching would false-positive here.
    expect(reasoningStaleFloorMs('warden3-13b')).toBe(0)
    expect(reasoningStaleFloorMs('siren1-7b')).toBe(0)
  })

  test('unknown chat models get no floor at all', () => {
    expect(reasoningStaleFloorMs('mistral-7b-instruct-q4')).toBe(0)
    expect(reasoningStaleFloorMs('')).toBe(0)
  })
})

describe('withReasoningFloor', () => {
  test('raises a default timeout to the family floor', () => {
    expect(withReasoningFloor('wichtel-qwen3.6-27b-q8_0', 90_000)).toBe(180_000)
  })

  test('never lowers a deliberately generous timeout', () => {
    // Zero's config says 300s; the 180s floor must not shorten it.
    expect(withReasoningFloor('huihui-qwen3.8-27b-abliterated-q8_0', 300_000)).toBe(300_000)
  })

  test('leaves non-reasoning models exactly as configured', () => {
    expect(withReasoningFloor('mistral-7b-instruct-q4', 90_000)).toBe(90_000)
  })
})
