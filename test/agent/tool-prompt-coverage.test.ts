import { describe, expect, test } from 'bun:test'
import { buildSystemPrompt } from '../../src/agent/context'
import { loadConfig } from '../../src/config'
import { createDefaultToolExecutor } from '../../src/tools'
import type { RuntimeConfig } from '../../src/config/schema'

/**
 * Every tool the model is handed must also be described in the system prompt.
 *
 * The prompt hand-writes its tool inventory, and that list drifted. `web_search` was registered,
 * passed in the tool schema, and wired to a working SearxNG — but never mentioned in the prompt,
 * so the model did not know it existed. Measured over 12 runs on questions that cannot be
 * answered without searching ("what is the latest Qwen model", "look up the current stable Bun
 * version"), it searched zero times and answered from memory with confident, unverifiable
 * specifics. That is precisely the failure web search exists to prevent.
 *
 * Nothing catches this on its own: the tool registers, the schema validates, no error is raised,
 * and the feature silently does nothing. Two lists maintained by hand will drift again, so this
 * asserts they agree.
 *
 * The config is built explicitly rather than read from disk — a test that loads the developer's
 * own egirl.toml passes or fails based on the machine it runs on, not the code.
 */
function testConfig(): RuntimeConfig {
  const base = loadConfig()
  return {
    ...base,
    searxng: { url: 'http://localhost:8889' },
    tools: {
      ...base.tools,
      files: true,
      exec: true,
      git: true,
      web_search: true,
      web_research: true,
      screenshot: true,
    },
  }
}

describe('system prompt tool coverage', () => {
  test('every registered tool is described in the system prompt', () => {
    const config = testConfig()
    const executor = createDefaultToolExecutor(config)
    const registered = executor.getDefinitions().map((d) => d.name)
    const { full: prompt } = buildSystemPrompt(config)

    expect(registered.length).toBeGreaterThan(0)
    const undocumented = registered.filter((name) => !prompt.includes(`\`${name}\``))
    expect(undocumented).toEqual([])
  })

  test('web_search is advertised when searxng is configured', () => {
    // Called out separately because this is the one that actually broke, and the regression is
    // silent: the agent keeps working and merely stops being able to look anything up.
    const config = testConfig()
    expect(buildSystemPrompt(config).full).toContain('`web_search`')
  })
})
