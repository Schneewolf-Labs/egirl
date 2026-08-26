import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatLintFindings, lintSkill } from '../../src/skills/linter'
import type { Skill } from '../../src/skills/types'

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'wine-probe-capture',
    description:
      'Use when capturing Wine game screens: drives the probe scripts and collects stderr.',
    content: '# Wine Probe Capture\n\n## Instructions\n\nRun the probe.',
    metadata: {},
    baseDir: mkdtempSync(join(tmpdir(), 'egirl-skill-')),
    enabled: true,
    ...overrides,
  }
}

describe('lintSkill', () => {
  test('a well-formed skill is clean', () => {
    expect(lintSkill(makeSkill())).toEqual([])
  })

  test('bad name and missing description are errors', () => {
    const findings = lintSkill(makeSkill({ name: 'Fix_DDraw_Today!', description: '' }))
    const errors = findings.filter((f) => f.level === 'error')
    expect(errors).toHaveLength(2)
  })

  test('session-artifact names warn', () => {
    const findings = lintSkill(makeSkill({ name: 'fix-ddraw-today' }))
    expect(findings.some((f) => f.message.includes('session artifact'))).toBe(true)
  })

  test('over-long and marketing descriptions warn', () => {
    const findings = lintSkill(
      makeSkill({
        description: `A powerful, seamless skill. ${'x'.repeat(220)} use when needed`,
      }),
    )
    expect(findings.some((f) => f.message.includes('truncate'))).toBe(true)
    expect(findings.some((f) => f.message.includes('marketing'))).toBe(true)
  })

  test('missing trigger condition warns', () => {
    const findings = lintSkill(makeSkill({ description: 'Parses RFH headers.' }))
    expect(findings.some((f) => f.message.includes('WHEN'))).toBe(true)
  })

  test('dangling relative link warns; existing link does not', () => {
    const skill = makeSkill()
    mkdirSync(join(skill.baseDir, 'references'), { recursive: true })
    writeFileSync(join(skill.baseDir, 'references/real.md'), 'x')
    skill.content = 'See [real](references/real.md) and [ghost](references/ghost.md).'
    const findings = lintSkill(skill)
    expect(findings.filter((f) => f.message.includes('dangling'))).toHaveLength(1)
    expect(findings[0]?.message).toContain('ghost.md')
  })

  test('formatLintFindings is empty for clean skills', () => {
    expect(formatLintFindings('x', [])).toBe('')
  })
})
