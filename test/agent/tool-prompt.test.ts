import { describe, expect, test } from 'bun:test'
import { buildSystemPrompt } from '../../src/agent/context'
import { buildToolsSection } from '../../src/agent/tool-prompt'
import { loadConfig } from '../../src/config'
import type { RuntimeConfig } from '../../src/config/schema'
import type { ToolDefinition } from '../../src/providers/types'
import { createDefaultToolExecutor } from '../../src/tools'

function def(name: string, description = `${name} does a thing.`): ToolDefinition {
  return { name, description, parameters: { type: 'object', properties: {} } }
}

/** A public, research-only instance: everything off except web search and fetch. */
function lockedDown(): RuntimeConfig {
  const base = loadConfig()
  const off = Object.fromEntries(
    Object.entries(base.tools).map(([k, v]) => [k, typeof v === 'boolean' ? false : v]),
  )
  return {
    ...base,
    searxng: { url: 'http://localhost:8889' },
    tools: { ...off, webSearch: true, webResearch: true } as RuntimeConfig['tools'],
  }
}

describe('tools section', () => {
  test('a locked-down instance is told only about the tools it has', () => {
    const config = lockedDown()
    const tools = createDefaultToolExecutor(config).getDefinitions()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['web_research', 'web_search'])

    const { full } = buildSystemPrompt(config, { tools })
    expect(full).toContain('`web_search`')
    expect(full).toContain('`web_research`')
    for (const absent of [
      'execute_command',
      'git_status',
      'code_agent',
      'write_file',
      'memory_set',
    ]) {
      expect(full).not.toContain(absent)
    }
    expect(full).not.toContain('Your workspace directory is')
    expect(full).not.toContain('Delegate coding work')
  })

  test('curated guidance appears only with its tools', () => {
    const section = buildToolsSection('/ws', [
      def('execute_command'),
      def('git_status'),
      def('edit_file'),
    ])
    expect(section).toContain('**System:**')
    expect(section).toContain('**Git:**')
    expect(section).toContain('Use git tools directly instead of running git via execute_command.')
    expect(section).toContain('Your workspace directory is `/ws`')
    expect(section).not.toContain('**Web:**')
    expect(section).not.toContain('code agent')

    const withAgent = buildToolsSection('/ws', [def('code_agent'), def('edit_file')])
    expect(withAgent).toContain('Delegate coding work to the code agent by default')
    expect(withAgent).toContain('Only use edit_file directly')
  })

  test('a registered tool without curated guidance is listed with its own description', () => {
    const section = buildToolsSection('/ws', [
      def('web_search'),
      def('wald_lookup', 'Look up an entry in the org state store. Returns JSON with history.'),
    ])
    expect(section).toContain('**Other:**')
    expect(section).toContain('- `wald_lookup` - Look up an entry in the org state store.')
    expect(section).not.toContain('Returns JSON')
  })

  test('calculate gets its curated "use it instead of mental math" line', () => {
    const section = buildToolsSection('/ws', [def('web_search'), def('calculate', 'Evaluate.')])
    expect(section).toContain('**Math:**')
    expect(section).toContain('instead of computing in your head')
    expect(section).not.toContain('**Other:**')
  })

  test('no tools, no section', () => {
    expect(buildToolsSection('/ws', [])).toBe('')
    const { full } = buildSystemPrompt(lockedDown(), { tools: [] })
    expect(full).not.toContain('## Available Tools')
  })
})
