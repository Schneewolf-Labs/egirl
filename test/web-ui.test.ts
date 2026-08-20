/**
 * The chat page.
 *
 * Most of it is markup, and markup does not need tests. What does: the instance name reaches the
 * page without becoming an injection vector, the token prompt appears exactly when a token is
 * actually required, and the ANSI palette converts to hex correctly -- because a silently wrong
 * colour makes two instances look identical in a browser, which is the one thing the theme is for.
 */

import { describe, expect, test } from 'bun:test'
import type { Theme } from '../src/ui/theme'
import { renderChatPage } from '../src/web-ui'

const theme = (primary: string, secondary = primary, accent = primary): Theme =>
  ({
    name: 'test',
    colors: {
      primary,
      secondary,
      accent,
      muted: '',
      success: '',
      error: '',
      warning: '',
      info: '',
    },
  }) as unknown as Theme

const egirlish = theme('\x1b[38;5;135m', '\x1b[38;5;198m', '\x1b[38;5;171m')

describe('renderChatPage', () => {
  test('puts the instance name in the title and header', () => {
    const html = renderChatPage({ name: 'zero', theme: egirlish, hasToken: false })
    expect(html).toContain('<title>zero</title>')
    expect(html).toContain('>zero<')
  })

  test('escapes a name that would otherwise inject markup', () => {
    // The name comes from config, which is user-controlled; a persona called `<script>` should
    // render as text, not execute.
    const html = renderChatPage({
      name: '<script>alert(1)</script>',
      theme: egirlish,
      hasToken: false,
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('asks for a token only when one is configured', () => {
    expect(renderChatPage({ name: 'a', theme: egirlish, hasToken: true })).toContain('prompt(')
    // Prompting on an instance with no token would be a dead end: there is nothing to enter.
    expect(renderChatPage({ name: 'a', theme: egirlish, hasToken: false })).not.toContain('prompt(')
  })

  test('converts the 256-colour palette to the right hex', () => {
    // 135 -> c=119 -> cube (3,1,5) -> 175,95,255. 198 -> c=182 -> (5,0,2) -> 255,0,135.
    // The exact values are asserted because a wrong-but-plausible colour is invisible to a test
    // that only checks "some colour appeared".
    const html = renderChatPage({ name: 'a', theme: egirlish, hasToken: false })
    expect(html).toContain('--p:#af5fff')
    expect(html).toContain('--s:#ff0087')
  })

  test('falls back to brand purple on an unparseable colour', () => {
    const html = renderChatPage({ name: 'a', theme: theme('not-ansi'), hasToken: false })
    expect(html).toContain('--p:#af5fd7')
  })

  test('handles greyscale ramp entries', () => {
    const html = renderChatPage({ name: 'a', theme: theme('\x1b[38;5;243m'), hasToken: false })
    expect(html).toContain('--p:#767676')
  })

  test('posts to a relative chat path so it works behind any host or port', () => {
    // An absolute URL would break the moment the page is reached by IP, hostname, or through a
    // tunnel -- which is most of how it will actually be opened.
    const html = renderChatPage({ name: 'a', theme: egirlish, hasToken: false })
    expect(html).toContain("fetch('chat'")
    expect(html).not.toContain('http://localhost')
  })

  test('carries a stable session id so a reload continues the conversation', () => {
    const html = renderChatPage({ name: 'a', theme: egirlish, hasToken: false })
    expect(html).toContain('localStorage')
    expect(html).toContain('session_id')
  })
})
