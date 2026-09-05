import { describe, expect, test } from 'bun:test'
import { buildHandoffRecord, isRolloverRecord, ROLLOVER_PREFIX } from '../../src/agent/handoff'
import { checkpointNudge, interjectionNudge } from '../../src/agent/nudges'
import type { ChatMessage } from '../../src/providers/types'

/**
 * The handoff record is the whole of what survives a context rollover, so its composition is
 * the contract: operator words verbatim, supervisor replies, the pending tool batch — and NOT
 * the model's own prose or consumed tool results.
 */

function conversation(): ChatMessage[] {
  return [
    { role: 'user', content: 'Reverse the RFH header format and write a parser.' },
    { role: 'assistant', content: 'I will start by dumping the header.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', name: 'execute_command', arguments: { command: 'xxd hdr.bin' } }],
    },
    { role: 'tool', content: 'CONSUMED HEXDUMP 00 01 02', tool_call_id: 'c1' },
    { role: 'assistant', content: 'The magic is 0x0001. SECRET REASONING about the layout.' },
    { role: 'user', content: checkpointNudge(true) },
    { role: 'user', content: interjectionNudge('Skip the checksum field, it is padding.') },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c2', name: 'report', arguments: { mode: 'ask', message: 'Big or little endian?' } },
      ],
    },
    { role: 'tool', content: 'Little endian, same as the v1 format.', tool_call_id: 'c2' },
    {
      role: 'assistant',
      content: 'Writing the parser now.',
      tool_calls: [
        { id: 'c3', name: 'write_file', arguments: { path: 'parser.py', content: 'x' } },
        { id: 'c4', name: 'execute_command', arguments: { command: 'python parser.py' } },
      ],
    },
    { role: 'tool', content: 'wrote parser.py', tool_call_id: 'c3' },
    { role: 'tool', content: 'PENDING OUTPUT: parsed 3 fields', tool_call_id: 'c4' },
  ]
}

describe('handoff record', () => {
  test('carries operator inputs verbatim and drops the model prose and consumed results', () => {
    const record = buildHandoffRecord(conversation(), { reason: 'auto' })
    const text = String(record.content)

    expect(record.role).toBe('user')
    expect(isRolloverRecord(record)).toBe(true)
    expect(text.startsWith(ROLLOVER_PREFIX)).toBe(true)

    expect(text).toContain('Reverse the RFH header format')
    // An interjection is the operator's words wrapped in a nudge — unwrapped, not skipped.
    expect(text).toContain('Skip the checksum field')
    expect(text).not.toContain('operator interjected')
    // Loop nudges are the loop talking, not state.
    expect(text).not.toContain('Checkpoint')

    expect(text).not.toContain('SECRET REASONING')
    expect(text).not.toContain('CONSUMED HEXDUMP')
  })

  test('keeps supervisor replies and the pending tool batch', () => {
    const text = String(buildHandoffRecord(conversation(), { reason: 'auto' }).content)

    expect(text).toContain('Big or little endian?')
    expect(text).toContain('Little endian, same as the v1 format.')

    expect(text).toContain('PENDING OUTPUT: parsed 3 fields')
    expect(text).toContain('wrote parser.py')
    expect(text).toContain('write_file(')
    // The batch's own narration comes along — it is what the results answer.
    expect(text).toContain('Writing the parser now.')
  })

  test('no pending batch when the window ends on a user turn', () => {
    const messages = conversation().slice(0, 2)
    const text = String(buildHandoffRecord(messages, { reason: 'auto' }).content)
    expect(text).not.toContain('Pending tool results')
  })

  test('a model-authored handoff heads the record and the reason is stated', () => {
    const text = String(
      buildHandoffRecord(conversation(), {
        reason: 'requested',
        handoff: 'Parser works for 3 fields; next: handle the optional trailer.',
      }).content,
    )
    expect(text).toContain('You requested a fresh context window')
    expect(text).toContain('handle the optional trailer')
    expect(text.indexOf('Handoff from your previous window')).toBeLessThan(
      text.indexOf('Operator inputs'),
    )
  })

  test('stays within its budget, keeping the newest inputs', () => {
    const messages: ChatMessage[] = []
    for (let i = 0; i < 200; i++) {
      messages.push({ role: 'user', content: `input number ${i} ${'x'.repeat(200)}` })
      messages.push({ role: 'assistant', content: `reply ${i}` })
    }
    const record = buildHandoffRecord(messages, { reason: 'auto', maxChars: 4000 })
    const text = String(record.content)

    expect(text.length).toBeLessThanOrEqual(4000 + 200) // header slack; never the full 40k
    expect(text).toContain('input number 199')
    expect(text).not.toContain('input number 0 ')
    expect(text).toMatch(/\d+ earlier input\(s\) omitted/)
  })

  test('an earlier rollover record is not carried as an operator input', () => {
    const first = buildHandoffRecord(conversation(), { reason: 'auto' })
    const second = buildHandoffRecord([first, { role: 'user', content: 'now also handle v2' }], {
      reason: 'auto',
    })
    const text = String(second.content)
    expect(text).toContain('now also handle v2')
    // The old record's header would otherwise nest verbatim inside the new one.
    expect(text.split(ROLLOVER_PREFIX).length).toBe(2)
  })
})
