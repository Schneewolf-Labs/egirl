import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { checkOffItem, heartbeatPreCheck, parseHeartbeatFile } from '../../src/tasks/heartbeat'

const TMP_DIR = join(import.meta.dir, '.tmp-heartbeat-test')

function setup(content?: string): string {
  mkdirSync(TMP_DIR, { recursive: true })
  if (content !== undefined) {
    writeFileSync(join(TMP_DIR, 'HEARTBEAT.md'), content, 'utf-8')
  }
  return TMP_DIR
}

afterEach(() => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    // ignore cleanup failures
  }
})

describe('parseHeartbeatFile', () => {
  test('returns unchecked items', async () => {
    const dir = setup(`# Heartbeat

- [ ] Check CI status
- [x] Already done
- [ ] Review open PRs
`)
    const items = await parseHeartbeatFile(dir)
    expect(items).toEqual(['Check CI status', 'Review open PRs'])
  })

  test('returns empty array when all checked', async () => {
    const dir = setup(`# Heartbeat

- [x] Done
- [x] Also done
`)
    const items = await parseHeartbeatFile(dir)
    expect(items).toEqual([])
  })

  test('returns empty array when file is missing', async () => {
    const dir = setup()
    const items = await parseHeartbeatFile(dir)
    expect(items).toEqual([])
  })

  test('returns empty array for empty file', async () => {
    const dir = setup('')
    const items = await parseHeartbeatFile(dir)
    expect(items).toEqual([])
  })

  test('returns empty for comment-only file', async () => {
    const dir = setup(`# Heartbeat Checks

No items yet.
`)
    const items = await parseHeartbeatFile(dir)
    expect(items).toEqual([])
  })

  test('handles indented checkboxes', async () => {
    const dir = setup(`# Checks

  - [ ] Indented item
    - [ ] Double indented
`)
    const items = await parseHeartbeatFile(dir)
    expect(items).toEqual(['Indented item', 'Double indented'])
  })

  test('handles tabs', async () => {
    const dir = setup(`\t- [ ] Tab indented item`)
    const items = await parseHeartbeatFile(dir)
    expect(items).toEqual(['Tab indented item'])
  })
})

describe('checkOffItem', () => {
  test('checks off matching item', async () => {
    const dir = setup(`- [ ] Check CI status
- [ ] Review PRs
`)
    const result = await checkOffItem(dir, 'Check CI status')
    expect(result).toBe(true)

    const items = await parseHeartbeatFile(dir)
    expect(items).toEqual(['Review PRs'])
  })

  test('returns false for non-matching item', async () => {
    const dir = setup(`- [ ] Check CI status`)
    const result = await checkOffItem(dir, 'Nonexistent item')
    expect(result).toBe(false)
  })

  test('returns false when file missing', async () => {
    const dir = setup()
    const result = await checkOffItem(dir, 'anything')
    expect(result).toBe(false)
  })

  test('does not affect other items', async () => {
    const dir = setup(`- [ ] First
- [ ] Second
- [ ] Third
`)
    await checkOffItem(dir, 'Second')
    const items = await parseHeartbeatFile(dir)
    expect(items).toEqual(['First', 'Third'])
  })

  test('handles special regex characters in item text', async () => {
    const dir = setup(`- [ ] Check CI (main branch)`)
    const result = await checkOffItem(dir, 'Check CI (main branch)')
    expect(result).toBe(true)

    const items = await parseHeartbeatFile(dir)
    expect(items).toEqual([])
  })
})

describe('heartbeatPreCheck', () => {
  test('returns undefined when no items', async () => {
    const dir = setup(`# Heartbeat

- [x] All done
`)
    const result = await heartbeatPreCheck(dir)
    expect(result).toBeUndefined()
  })

  test('returns undefined when file missing', async () => {
    const dir = setup()
    const result = await heartbeatPreCheck(dir)
    expect(result).toBeUndefined()
  })

  test('returns prompt with items when unchecked exist', async () => {
    const dir = setup(`- [ ] Check CI status
- [ ] Review PRs
`)
    const result = await heartbeatPreCheck(dir)
    expect(result).toBeDefined()
    expect(result).toContain('Check CI status')
    expect(result).toContain('Review PRs')
    expect(result).toContain('HEARTBEAT.md')
  })

  test('returns prompt with only unchecked items', async () => {
    const dir = setup(`- [x] Done
- [ ] Pending
- [x] Also done
`)
    const result = await heartbeatPreCheck(dir)
    expect(result).toBeDefined()
    expect(result).toContain('Pending')
    expect(result).not.toContain('Done')
    expect(result).not.toContain('Also done')
  })
})
