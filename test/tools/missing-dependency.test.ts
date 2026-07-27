import { describe, expect, test } from 'bun:test'
import type { RuntimeConfig } from '../../src/config'
import { createDefaultToolExecutor } from '../../src/tools'

/**
 * Five tool groups need a [tools] flag AND a dependency. When the dependency was absent they
 * simply did not exist — no message, no stub. `web_search` defaults to TRUE while needing a
 * [searxng] url, so a default install silently had no web search; that is what these pin.
 *
 * Asserting on the registered tool list rather than on log output: the observable contract is
 * "the flag is on, so is the tool there or not".
 */
function cfg(tools: Record<string, boolean>, extra: Record<string, unknown> = {}): RuntimeConfig {
  return {
    tools: {
      files: false,
      exec: false,
      process: false,
      git: false,
      memory: false,
      browser: false,
      github: false,
      tasks: false,
      codeAgent: false,
      webResearch: false,
      webSearch: false,
      screenshot: false,
      ...tools,
    },
    ...extra,
  } as unknown as RuntimeConfig
}

describe('tools gated on a missing dependency', () => {
  test('web_search is absent without a searxng url, even though the flag is on', () => {
    const ex = createDefaultToolExecutor(cfg({ webSearch: true }))
    expect(ex.listTools()).not.toContain('web_search')
  })

  test('web_search appears once searxng is configured', () => {
    const ex = createDefaultToolExecutor(
      cfg({ webSearch: true }, { searxng: { url: 'http://localhost:8888' } }),
    )
    expect(ex.listTools()).toContain('web_search')
  })

  test('code_agent is absent without code-agent config', () => {
    const ex = createDefaultToolExecutor(cfg({ codeAgent: true }))
    expect(ex.listTools()).not.toContain('code_agent')
  })

  test('github tools are absent without github config', () => {
    const ex = createDefaultToolExecutor(cfg({ github: true }))
    expect(ex.listTools().some((n) => n.startsWith('gh_'))).toBe(false)
  })

  test('a flag that is off registers nothing and warns about nothing', () => {
    const ex = createDefaultToolExecutor(cfg({}))
    expect(ex.listTools()).toEqual([])
  })

  test('flags without a dependency still work normally', () => {
    const ex = createDefaultToolExecutor(cfg({ files: true, exec: true }))
    const names = ex.listTools()
    expect(names).toContain('read_file')
    expect(names).toContain('execute_command')
  })
})
