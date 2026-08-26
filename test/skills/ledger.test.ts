import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLedger, rollbackEntry, withSkillLedger } from '../../src/skills/ledger'
import { writeTool } from '../../src/tools/builtin/write'

let root: string
let skillsDir: string
let ledgerDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'egirl-ledger-'))
  skillsDir = join(root, 'skills')
  ledgerDir = join(root, '.skill-ledger')
  mkdirSync(skillsDir, { recursive: true })
})

describe('withSkillLedger', () => {
  test('a write inside the skills dir is recorded with before/after blobs', async () => {
    const wrapped = withSkillLedger(writeTool, [skillsDir], ledgerDir)
    const path = join(skillsDir, 'wine-probe/SKILL.md')

    const r1 = await wrapped.execute({ path, content: '# v1' }, root)
    expect(r1.success).toBe(true)
    const r2 = await wrapped.execute({ path, content: '# v2' }, root)
    expect(r2.success).toBe(true)

    const entries = readLedger(ledgerDir)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.before).toBeNull() // file did not exist
    expect(entries[1]?.before).not.toBeNull()
    expect(entries[1]?.tool).toBe('write_file')
    // Blobs are content-addressed and present
    expect(existsSync(join(ledgerDir, 'blobs', entries[1]?.after as string))).toBe(true)
  })

  test('writes outside the skills dir are not recorded', async () => {
    const wrapped = withSkillLedger(writeTool, [skillsDir], ledgerDir)
    await wrapped.execute({ path: join(root, 'NOTES.md'), content: 'notes' }, root)
    expect(readLedger(ledgerDir)).toHaveLength(0)
  })

  test('identical content writes are not recorded as mutations', async () => {
    const wrapped = withSkillLedger(writeTool, [skillsDir], ledgerDir)
    const path = join(skillsDir, 's/SKILL.md')
    await wrapped.execute({ path, content: 'same' }, root)
    await wrapped.execute({ path, content: 'same' }, root)
    expect(readLedger(ledgerDir)).toHaveLength(1)
  })
})

describe('rollbackEntry', () => {
  test('restores the before state and records the rollback itself', async () => {
    const wrapped = withSkillLedger(writeTool, [skillsDir], ledgerDir)
    const path = join(skillsDir, 's/SKILL.md')
    await wrapped.execute({ path, content: '# good' }, root)
    await wrapped.execute({ path, content: '# bad edit' }, root)

    const entries = readLedger(ledgerDir)
    const bad = entries[1]
    if (!bad) throw new Error('missing entry')
    const result = rollbackEntry(ledgerDir, bad, [skillsDir])
    expect(result.ok).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('# good')
    // The rollback appended its own safety entry
    expect(readLedger(ledgerDir)).toHaveLength(3)
  })

  test('refuses paths outside the allowed roots', () => {
    writeFileSync(join(root, 'outside.md'), 'x')
    const result = rollbackEntry(
      ledgerDir,
      {
        ts: 'x',
        actor: 'agent',
        tool: 'write_file',
        path: join(root, 'outside.md'),
        before: null,
        after: 'deadbeef',
      },
      [skillsDir],
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('outside the allowed')
  })

  test('fails closed on a missing blob', async () => {
    const wrapped = withSkillLedger(writeTool, [skillsDir], ledgerDir)
    const path = join(skillsDir, 's/SKILL.md')
    await wrapped.execute({ path, content: 'v1' }, root)
    await wrapped.execute({ path, content: 'v2' }, root)
    const entry = readLedger(ledgerDir)[1]
    if (!entry) throw new Error('missing entry')
    const tampered = { ...entry, before: 'f'.repeat(64) }
    const result = rollbackEntry(ledgerDir, tampered, [skillsDir])
    expect(result.ok).toBe(false)
    expect(result.error).toContain('missing blob')
  })
})
