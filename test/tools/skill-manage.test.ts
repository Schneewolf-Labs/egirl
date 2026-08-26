import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLedger } from '../../src/skills/ledger'
import { createSkillManageTool, findPatchTarget } from '../../src/tools/builtin/skill-manage'

let skillsDir: string
let ledgerDir: string

const GOOD_BODY = `# Wine Probe Capture

Use when capturing Wine game screens: drives probe scripts and collects stderr.

## When to Use

Any capture task.

## Instructions

Run the probe script.`

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'egirl-sm-'))
  skillsDir = join(root, 'skills')
  ledgerDir = join(root, '.skill-ledger')
  mkdirSync(skillsDir, { recursive: true })
})

describe('findPatchTarget', () => {
  test('exact unique match', () => {
    const r = findPatchTarget('abc def ghi', 'def')
    expect('start' in r && r.start).toBe(4)
  })

  test('ambiguous match errors', () => {
    const r = findPatchTarget('x y x', 'x')
    expect('error' in r && r.error).toContain('more than once')
  })

  test('whitespace-tolerant match maps to raw offsets', () => {
    // The quoted text lost its indentation (a transcript re-quote); exact match fails,
    // the tolerant pass still lands on the indented original.
    const content = 'line one\n  foo step\n  bar step\nline four'
    const r = findPatchTarget(content, 'foo step\nbar step')
    expect('start' in r).toBe(true)
    if ('start' in r) {
      expect(content.slice(r.start, r.end)).toBe('  foo step\n  bar step')
    }
  })
})

describe('skill_manage', () => {
  test('create stamps origin, writes the file, records the ledger', async () => {
    const tool = createSkillManageTool([skillsDir], ledgerDir)
    const r = await tool.execute(
      { action: 'create', name: 'wine-probe-capture', content: GOOD_BODY },
      skillsDir,
    )
    expect(r.success).toBe(true)
    const written = readFileSync(join(skillsDir, 'wine-probe-capture/SKILL.md'), 'utf8')
    expect(written).toContain('origin: agent')
    expect(written).toContain('# Wine Probe Capture')
    expect(readLedger(ledgerDir)).toHaveLength(1)
  })

  test('create refuses an existing skill and points at patch', async () => {
    const tool = createSkillManageTool([skillsDir], ledgerDir)
    await tool.execute(
      { action: 'create', name: 'wine-probe-capture', content: GOOD_BODY },
      skillsDir,
    )
    const r = await tool.execute(
      { action: 'create', name: 'wine-probe-capture', content: GOOD_BODY },
      skillsDir,
    )
    expect(r.success).toBe(false)
    expect(r.output).toContain('patch')
  })

  test('create with structural lint errors is not written', async () => {
    const tool = createSkillManageTool([skillsDir], ledgerDir)
    const r = await tool.execute(
      { action: 'create', name: 'BadName', content: GOOD_BODY },
      skillsDir,
    )
    expect(r.success).toBe(false)
    expect(existsSync(join(skillsDir, 'BadName'))).toBe(false)
  })

  test('patch replaces uniquely matching text', async () => {
    const tool = createSkillManageTool([skillsDir], ledgerDir)
    await tool.execute(
      { action: 'create', name: 'wine-probe-capture', content: GOOD_BODY },
      skillsDir,
    )
    const r = await tool.execute(
      {
        action: 'patch',
        name: 'wine-probe-capture',
        old_text: 'Run the probe script.',
        new_text: 'Run the probe script with WINEDEBUG=+loaddll.',
      },
      skillsDir,
    )
    expect(r.success).toBe(true)
    expect(readFileSync(join(skillsDir, 'wine-probe-capture/SKILL.md'), 'utf8')).toContain(
      'WINEDEBUG=+loaddll',
    )
    expect(readLedger(ledgerDir)).toHaveLength(2)
  })

  test('background actor may not touch non-agent skills', async () => {
    // A hand-authored skill without origin: agent frontmatter.
    mkdirSync(join(skillsDir, 'user-skill'), { recursive: true })
    writeFileSync(join(skillsDir, 'user-skill/SKILL.md'), GOOD_BODY)
    const tool = createSkillManageTool([skillsDir], ledgerDir, { actor: 'background' })
    const r = await tool.execute(
      { action: 'patch', name: 'user-skill', old_text: 'probe', new_text: 'x' },
      skillsDir,
    )
    expect(r.success).toBe(false)
    expect(r.output).toContain('not agent-created')
  })

  test('archive moves the skill, never deletes', async () => {
    const tool = createSkillManageTool([skillsDir], ledgerDir)
    await tool.execute(
      { action: 'create', name: 'wine-probe-capture', content: GOOD_BODY },
      skillsDir,
    )
    const r = await tool.execute({ action: 'archive', name: 'wine-probe-capture' }, skillsDir)
    expect(r.success).toBe(true)
    expect(existsSync(join(skillsDir, 'wine-probe-capture'))).toBe(false)
    expect(existsSync(join(skillsDir, '.archive/wine-probe-capture/SKILL.md'))).toBe(true)
  })
})
