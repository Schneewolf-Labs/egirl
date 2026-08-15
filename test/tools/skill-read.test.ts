/**
 * Skills are advertised by name and loaded on demand.
 *
 * The system prompt used to inline every skill's full body. Two bundled skills is ~2.5KB of a
 * 12.5KB stable prefix — unremarkable, right up until skills are written rather than shipped,
 * because then success looks like more skills. Thirty of them is ~40KB spent before the
 * conversation starts, on instructions irrelevant to almost every turn.
 *
 * So the prompt lists what each skill is *for*, and `skill_read` returns how to do it. The
 * property worth protecting is that the two halves stay consistent: a name that appears in the
 * prompt must be loadable, and a body must not leak back into the prefix.
 */

import { describe, expect, test } from 'bun:test'
import { createSkillReadTool } from '../../src/tools/builtin/skill'
import type { Skill } from '../../src/skills/types'

function skill(name: string, description: string, content: string): Skill {
  return {
    name,
    description,
    content,
    metadata: {},
    baseDir: `/tmp/skills/${name}`,
    enabled: true,
  }
}

const SKILLS: Skill[] = [
  skill('Code Review', 'Review a diff for correctness.', '# Code Review\n\n1. Read the diff'),
  skill('hemlock', 'Write and debug Hemlock programs.', '# hemlock\n\nUse hemlockc to build.'),
]

const tool = createSkillReadTool(SKILLS)

describe('skill_read', () => {
  test('returns the body of a named skill', async () => {
    const r = await tool.execute({ name: 'hemlock' }, '/tmp')
    expect(r.success).toBe(true)
    expect(r.output).toContain('hemlockc')
  })

  test('matches a slug against a display name', async () => {
    // Models routinely pass "code-review" for a skill displayed as "Code Review".
    const r = await tool.execute({ name: 'code-review' }, '/tmp')
    expect(r.success).toBe(true)
    expect(r.output).toContain('Read the diff')
  })

  test('is case insensitive', async () => {
    const r = await tool.execute({ name: 'HEMLOCK' }, '/tmp')
    expect(r.success).toBe(true)
  })

  test('an unknown skill lists what is available instead of failing blankly', async () => {
    const r = await tool.execute({ name: 'nonexistent' }, '/tmp')
    expect(r.success).toBe(false)
    expect(r.output).toContain('hemlock')
    expect(r.output).toContain('Code Review')
  })

  test('an empty name is rejected', async () => {
    const r = await tool.execute({ name: '   ' }, '/tmp')
    expect(r.success).toBe(false)
  })

  test('every advertised skill is loadable', async () => {
    // The prompt lists these names; a name that cannot be read is a dead end for the model.
    for (const s of SKILLS) {
      const r = await tool.execute({ name: s.name }, '/tmp')
      expect(r.success).toBe(true)
    }
  })
})
