import { describe, expect, test } from 'bun:test'
import { formatStateBrief } from '../../src/tasks/runner'

describe('formatStateBrief', () => {
  test('frames content as settled ground truth', () => {
    const out = formatStateBrief('## PROVEN\n- type-1 decompressor solved', 'STATE.md')
    expect(out).toBeDefined()
    expect(out).toContain('Pinned task state')
    expect(out).toContain('do NOT re-derive')
    expect(out).toContain('type-1 decompressor solved')
  })

  test('empty or whitespace-only content yields undefined (nothing to pin)', () => {
    expect(formatStateBrief('', 'STATE.md')).toBeUndefined()
    expect(formatStateBrief('   \n\t ', 'STATE.md')).toBeUndefined()
  })

  test('truncates over-long content head-first, keeping the ledger at the top', () => {
    const ledger = '## PROVEN\n- asset pipeline byte-exact\n'
    const big = ledger + 'x'.repeat(40000)
    const out = formatStateBrief(big, 'lego_loco/STATE.md')!
    expect(out).toContain('asset pipeline byte-exact')
    expect(out).toContain('[state brief truncated — full file at lego_loco/STATE.md]')
    // Framing + 16k body + truncation notice — nowhere near the full 40k.
    expect(out.length).toBeLessThan(17000)
  })
})
