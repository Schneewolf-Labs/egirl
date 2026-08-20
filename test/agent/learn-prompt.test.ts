/**
 * /learn -- the prompt builder and its surface wiring.
 *
 * The builder is a pure function; what needs pinning is the contract the agent depends on:
 * the target directory is named explicitly, the empty request means "this conversation",
 * and the user's requirements travel into the prompt intact.
 */

import { describe, expect, test } from 'bun:test'
import { buildLearnPrompt } from '../../src/agent/learn-prompt'

describe('buildLearnPrompt', () => {
  test('names the skills directory explicitly', () => {
    const p = buildLearnPrompt('the deploy dance', '/home/kira/.egirl/skills')
    expect(p).toContain('/home/kira/.egirl/skills/<name>/SKILL.md')
  })

  test('an empty request means distill this conversation', () => {
    const p = buildLearnPrompt('   ', '/skills')
    expect(p).toContain('the workflow we just went through in this conversation')
  })

  test('the request text travels intact, requirements and all', () => {
    const req = '~/notes/rfh.md focus on the header layout, skip the palette stuff'
    const p = buildLearnPrompt(req, '/skills')
    expect(p).toContain(req)
    // The instruction that prevents gather-first-ignore-rest must be present.
    expect(p).toContain('Never gather the first source and ignore the rest')
  })

  test('asks for the SKILL.md shape the parser expects', () => {
    const p = buildLearnPrompt('x', '/skills')
    expect(p).toContain('# Title')
    expect(p).toContain('## When to Use')
    expect(p).toContain('## Instructions')
  })
})
