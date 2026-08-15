/**
 * The skills section must stay a listing, not a manual.
 *
 * This is the constraint that makes self-authored skills viable: prompt cost has to grow with
 * the *number* of skills, not their total length. Inlining bodies means a skill Kira writes for
 * Hemlock is paid for on every unrelated turn forever.
 */

import { describe, expect, test } from 'bun:test'
import { buildSystemPrompt } from '../../src/agent/context'
import type { Skill } from '../../src/skills/types'
import type { RuntimeConfig } from '../../src/config'

const BODY_MARKER = 'STEP_ONE_RUN_HEMLOCKC'

function skill(name: string, description: string, bodyLength = 4000): Skill {
  return {
    name,
    description,
    content: `# ${name}\n\n${BODY_MARKER}\n${'x'.repeat(bodyLength)}`,
    metadata: {},
    baseDir: `/tmp/${name}`,
    enabled: true,
  }
}

function config(): RuntimeConfig {
  return {
    workspace: { path: '/tmp/ws' },
    local: { endpoint: 'http://127.0.0.1:8080', model: 'm', contextLength: 131072 },
  } as unknown as RuntimeConfig
}

describe('skills section', () => {
  test('advertises the name and description', () => {
    const { full } = buildSystemPrompt(config(), {
      skills: [skill('hemlock', 'Write and debug Hemlock programs.')],
    })
    expect(full).toContain('hemlock')
    expect(full).toContain('Write and debug Hemlock programs.')
  })

  test('does not inline the body', () => {
    const { full } = buildSystemPrompt(config(), {
      skills: [skill('hemlock', 'Write and debug Hemlock programs.')],
    })
    expect(full).not.toContain(BODY_MARKER)
  })

  test('tells the model how to get the instructions', () => {
    const { full } = buildSystemPrompt(config(), {
      skills: [skill('hemlock', 'desc')],
    })
    expect(full).toContain('skill_read')
  })

  test('prompt cost scales with skill count, not skill size', () => {
    const small = buildSystemPrompt(config(), { skills: [skill('a', 'does a', 100)] }).full.length
    const large = buildSystemPrompt(config(), { skills: [skill('a', 'does a', 40_000)] }).full.length
    // A 400x larger body must not move the prompt.
    expect(large).toBe(small)
  })

  test('ten skills stay cheap', () => {
    const many = Array.from({ length: 10 }, (_, i) => skill(`skill-${i}`, `does thing ${i}`))
    const { full } = buildSystemPrompt(config(), { skills: many })
    const none = buildSystemPrompt(config(), {}).full
    // Ten 4KB skills would have been ~40KB inlined; as a listing it is a few hundred bytes.
    expect(full.length - none.length).toBeLessThan(1500)
  })

  test('a skill with no description still lists rather than vanishing', () => {
    const s = skill('mystery', '')
    const { full } = buildSystemPrompt(config(), { skills: [s] })
    expect(full).toContain('mystery')
  })
})
