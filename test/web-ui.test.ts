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

describe('console panels', () => {
  const html = () => renderChatPage({ name: 'zero', theme: egirlish, hasToken: false })

  test('has chat, memory, prompt and info tabs', () => {
    for (const tab of ['chat', 'memory', 'prompt', 'info']) {
      expect(html()).toContain(`data-tab="${tab}"`)
    }
  })

  test('fetches identity, prompt and memory from relative paths', () => {
    // Relative, because the page is opened by IP, by hostname and through tunnels -- an absolute
    // URL works for exactly one of those.
    const h = html()
    expect(h).toContain("fetch('info'")
    expect(h).toContain("fetch('prompt?session_id=")
    expect(h).toContain("fetch('memory?limit=")
  })

  test('loads identity eagerly and the rest lazily', () => {
    // The header should say what you are talking to before you say anything to it; the system
    // prompt and memory store should not be fetched by merely opening the page.
    const h = html()
    expect(h).toContain('loadInfo(); loaded.info=1;')
    expect(h).toContain("if(t==='prompt')loadPrompt()")
  })

  test('escapes memory values, which are model-authored text', () => {
    // Memory contents are written by the agent and can contain anything; rendering them raw
    // would make the store a stored-XSS vector against its own console.
    expect(html()).toContain('const esc=')
    expect(html()).toContain('esc(x.value)')
  })

  test('explains a disabled memory store rather than showing an error', () => {
    expect(html()).toContain('r.status===503')
    expect(html()).toContain('Memory is disabled')
  })

  describe('polling', () => {
    /**
     * Pull poller() out of the served script and run it against stubbed timers and a stubbed
     * document, so the actual shipped implementation is what gets exercised. Brace-matching
     * rather than a regex because the function body has nested blocks.
     */
    function harness() {
      const src = html()
      const start = src.indexOf('function poller(')
      if (start < 0) throw new Error('poller() not found in the served page')
      let depth = 0
      let end = start
      for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++
        else if (src[i] === '}') {
          depth--
          if (depth === 0) {
            end = i + 1
            break
          }
        }
      }
      const timers: Array<{ fn: () => void; delay: number }> = []
      const doc = { hidden: false, addEventListener() {} }
      const scope = {
        document: doc,
        setTimeout: (fn: () => void, delay: number) => timers.push({ fn, delay }) - 1,
        clearTimeout: () => {},
        setOnline: () => {},
      }
      const make = new Function(
        'document',
        'setTimeout',
        'clearTimeout',
        'setOnline',
        `${src.slice(start, end)}; return poller;`,
      )(scope.document, scope.setTimeout, scope.clearTimeout, scope.setOnline)
      // Run whatever is scheduled and hand back the delay it was queued with.
      const step = async () => {
        const next = timers.pop()
        if (!next) throw new Error('nothing scheduled')
        next.fn()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        return next.delay
      }
      return { make, doc, timers, step }
    }

    test('backs off exponentially while failing and resets on success', async () => {
      // A dead instance used to be retried every 5s forever. Each failure doubles the wait, up
      // to a cap, so a box that is down gets checked occasionally instead of hammered.
      const { make, timers, step } = harness()
      let fail = true
      make(
        async () => {
          if (fail) throw new Error('down')
        },
        1000,
        8000,
      )
      expect(timers[0]?.delay).toBe(1000) // first poll at the base delay
      await step()
      expect(timers[0]?.delay).toBe(2000) // failed: doubled
      await step()
      expect(timers[0]?.delay).toBe(4000)
      await step()
      expect(timers[0]?.delay).toBe(8000)
      await step()
      expect(timers[0]?.delay).toBe(8000) // capped, not unbounded
      fail = false
      await step()
      expect(timers[0]?.delay).toBe(1000) // recovered: straight back to base
    })

    test('does not poll while the tab is hidden', async () => {
      // The whole point: a phone with this open in a background tab must not sit on the radio
      // all night refreshing a screen nobody can see.
      const { make, doc, timers, step } = harness()
      let calls = 0
      doc.hidden = true
      make(async () => {
        calls++
      }, 1000, 8000)
      await step()
      await step()
      expect(calls).toBe(0) // skipped, but still rescheduled
      expect(timers.length).toBe(1)
      doc.hidden = false
      await step()
      expect(calls).toBe(1)
    })
  })

  describe('the saved token', () => {
    test('offers a way to forget it, and re-prompts after a rejection', () => {
      // The token outlives the tab (localStorage, so a phone is not asked every visit), which
      // means there has to be a way to hand the device back. And a mistyped or rotated token
      // used to leave the console 401ing forever with no way to correct it short of devtools.
      const h = renderChatPage({ name: 'z', theme: egirlish, hasToken: true })
      expect(h).toContain('id="forgettok"')
      expect(h).toContain("localStorage.removeItem('egirl-token')")
      expect(h).toContain('res.status===401')
    })

    test('says nothing about tokens on an instance that has none', () => {
      const h = renderChatPage({ name: 'z', theme: egirlish, hasToken: false })
      // The button itself is absent; the script's guarded lookup for it may still be present.
      expect(h).not.toContain('id="forgettok"')
      expect(h).not.toContain('this browser')
    })

    test('never opens a blocking dialog to report an auth failure', () => {
      // A modal freezes every other event on the page -- including the polling loop and any
      // in-flight stream. The reason rides across the reload as status text instead.
      const h = renderChatPage({ name: 'z', theme: egirlish, hasToken: true })
      expect(h).not.toContain('alert(')
      expect(h).toContain("sessionStorage.setItem('egirl-authmsg'")
    })
  })

  describe('client-side escaping', () => {
    /**
     * The page's own esc(), pulled out of the served script and made callable, so these test
     * what the browser actually runs rather than asserting on source text.
     */
    function clientEsc(): (s: unknown) => string {
      const m = /const esc=(t=>String\(t\?\?''\)\.replace\(.*?\));/.exec(html())
      if (!m) throw new Error('could not find esc() in the served page')
      return eval(`(${m[1]})`) as (s: unknown) => string
    }

    test('escapes quotes as well as angle brackets', () => {
      // Escaped values are interpolated into double-quoted attributes (href, data-*). A quote
      // that survives closes the attribute early and everything after it parses as further
      // attributes -- including an event handler, with no whitespace required. This was a live
      // hole: `[docs](https://evil/x"onmouseover="...)` in agent output rendered an anchor with
      // a working handler, and the API token in localStorage sits in front of execute_command.
      const esc = clientEsc()
      expect(esc('"')).toBe('&quot;')
      expect(esc("'")).toBe('&#39;')
      expect(esc('<script>')).toBe('&lt;script&gt;')
      expect(esc('a&b')).toBe('a&amp;b')
      expect(esc('x"onmouseover="alert(1)')).not.toContain('"')
    })

    test('leaves ordinary text intact apart from the escapes', () => {
      // Quotes and apostrophes are ordinary content in prose: they must become entities that
      // render back to the original characters, not get stripped.
      const esc = clientEsc()
      expect(esc("it's carry-driven")).toBe('it&#39;s carry-driven')
      expect(esc('plain text')).toBe('plain text')
    })

    test('markdown link URLs cannot carry attribute syntax', () => {
      // Defence in depth behind esc(): the URL charset excludes quotes and angle brackets, so a
      // link cannot contribute attribute syntax even if escaping regressed. http/https only --
      // a javascript: or data: URL is a payload, not a link.
      expect(html()).toContain(`"'<>]+`)
    })
  })
})
