/**
 * A screenshot must survive the context window.
 *
 * The screenshot tool returns `data:image/png;base64,...` -- 2.5MB of base64 for a 3440x1440
 * capture. Tool results are truncated to a token budget (8k by default) by slicing the string, so
 * the image arrived at the model as 28k characters of base64 cut mid-stream and llama.cpp
 * rejected it:
 *
 *     400 - {"error":{"message":"Failed to load image or audio file"}}
 *
 * The tool has therefore never worked in a live conversation, while sending the identical image
 * outside the agent succeeded -- which is what made it look like a serving problem.
 *
 * Counting was wrong in the same way: 2.5MB of base64 estimates at ~730k tokens as text, so a
 * single screenshot appeared to overflow a 131k window on its own.
 */

import { describe, expect, test } from 'bun:test'
import { IMAGE_TOKENS, isDataUrl, truncateToolResultSync } from '../../src/agent/context-window'

// Shape matters more than size here: prefix, `;base64,`, then payload.
const bigImage = `data:image/png;base64,${'A'.repeat(2_500_000)}`

describe('data URLs in tool results', () => {
  test('a data URL is recognised', () => {
    expect(isDataUrl(bigImage)).toBe(true)
    expect(isDataUrl('data:image/jpeg;base64,xyz')).toBe(true)
  })

  test('ordinary text is not', () => {
    expect(isDataUrl('the file contains data: something')).toBe(false)
    expect(isDataUrl('')).toBe(false)
  })

  test('a URL without base64 is not treated as an image payload', () => {
    expect(isDataUrl('data:text/plain,hello')).toBe(false)
  })

  test('a screenshot is not truncated', () => {
    // Slicing produces a corrupt image, not a smaller one.
    const out = truncateToolResultSync(bigImage, 8000)
    expect(out).toBe(bigImage)
    expect(out).not.toContain('truncated')
  })

  test('the base64 payload survives intact', () => {
    const out = truncateToolResultSync(bigImage, 8000)
    expect(out.length).toBe(bigImage.length)
    expect(out.endsWith('A')).toBe(true)
  })

  test('ordinary oversized output is still truncated', () => {
    const prose = 'x'.repeat(200_000)
    const out = truncateToolResultSync(prose, 1000)
    expect(out.length).toBeLessThan(prose.length)
    expect(out).toContain('truncated')
  })

  test('an image costs image tokens, not character tokens', () => {
    // As text this would estimate ~730k tokens and appear to overflow the window by itself.
    const asText = Math.ceil(bigImage.length / 3.5)
    expect(asText).toBeGreaterThan(500_000)
    expect(IMAGE_TOKENS).toBeLessThan(5000)
  })
})
