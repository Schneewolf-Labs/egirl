import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyOperations,
  createWorkingMemoryTool,
  WORKING_MEMORY_MAX_CHARS,
} from '../../src/tools/builtin/working-memory'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'egirl-wm-'))
})

describe('applyOperations', () => {
  test('batch remove+replace+add applies atomically', () => {
    const r = applyOperations(
      ['- old fact', '- stale thing', '- keep me'],
      [
        { op: 'remove', match: 'stale thing' },
        { op: 'replace', match: 'old fact', text: '- merged fact' },
        { op: 'add', text: '- new fact' },
      ],
    )
    expect(r.error).toBeUndefined()
    expect(r.entries).toEqual(['- merged fact', '- keep me', '- new fact'])
  })

  test('a failed op leaves entries untouched', () => {
    const r = applyOperations(['- a'], [{ op: 'remove', match: 'nope' }])
    expect(r.error).toContain('No unique entry')
    expect(r.entries).toEqual(['- a'])
  })

  test('duplicate add is rejected', () => {
    const r = applyOperations(['- a fact'], [{ op: 'add', text: '- a fact' }])
    expect(r.error).toContain('Duplicate')
  })

  test('match by 1-based index works', () => {
    const r = applyOperations(['- one', '- two'], [{ op: 'remove', match: '2' }])
    expect(r.entries).toEqual(['- one'])
  })
})

describe('working_memory tool', () => {
  test('add persists to MEMORY.md and success does not echo the entry', async () => {
    const tool = createWorkingMemoryTool(workspace)
    const r = await tool.execute(
      { action: 'add', text: '- decompressor is byte-exact solved' },
      workspace,
    )
    expect(r.success).toBe(true)
    expect(r.output).toContain('do not repeat it')
    expect(r.output).not.toContain('decompressor')
    expect(readFileSync(join(workspace, 'MEMORY.md'), 'utf8')).toContain('byte-exact solved')
  })

  test('add at capacity is rejected with the current entries and consolidate instruction', async () => {
    const big = `- ${'x'.repeat(WORKING_MEMORY_MAX_CHARS - 10)}`
    writeFileSync(join(workspace, 'MEMORY.md'), `${big}\n`)
    const tool = createWorkingMemoryTool(workspace)
    const r = await tool.execute({ action: 'add', text: '- one more fact' }, workspace)
    expect(r.success).toBe(false)
    expect(r.output).toContain('over the')
    expect(r.output).toContain('consolidate now')
    expect(r.output).toContain('1. -') // numbered inventory echoed
    // File unchanged
    expect(readFileSync(join(workspace, 'MEMORY.md'), 'utf8')).not.toContain('one more fact')
  })

  test('consolidating batch frees room and adds in one call', async () => {
    const half = `- ${'a'.repeat(WORKING_MEMORY_MAX_CHARS / 2)}`
    const other = `- ${'b'.repeat(WORKING_MEMORY_MAX_CHARS / 2 - 10)}`
    writeFileSync(join(workspace, 'MEMORY.md'), `${half}\n${other}\n`)
    const tool = createWorkingMemoryTool(workspace)
    const r = await tool.execute(
      {
        action: 'add',
        operations: [
          { op: 'remove', match: 'aaaa' },
          { op: 'add', text: '- compact merged summary' },
        ],
      },
      workspace,
    )
    expect(r.success).toBe(true)
    const file = readFileSync(join(workspace, 'MEMORY.md'), 'utf8')
    expect(file).toContain('compact merged summary')
    expect(file).not.toContain('aaaa')
  })

  test('third consecutive failure tells the model to stop retrying', async () => {
    const tool = createWorkingMemoryTool(workspace)
    await tool.execute({ action: 'remove', match: 'ghost' }, workspace)
    await tool.execute({ action: 'remove', match: 'ghost' }, workspace)
    const r = await tool.execute({ action: 'remove', match: 'ghost' }, workspace)
    expect(r.success).toBe(false)
    expect(r.output).toContain('STOP retrying')
  })

  test('list shows numbered entries with budget usage', async () => {
    writeFileSync(join(workspace, 'MEMORY.md'), '- alpha\n- beta\n')
    const tool = createWorkingMemoryTool(workspace)
    const r = await tool.execute({ action: 'list' }, workspace)
    expect(r.success).toBe(true)
    expect(r.output).toContain('1. - alpha')
    expect(r.output).toContain('2. - beta')
    expect(r.output).toContain(`/${WORKING_MEMORY_MAX_CHARS} chars`)
  })
})
