/**
 * The mailbox client against Wald's actual wire shape: one indented JSON block per row,
 * joined with newlines by the MCP client, and no blocks at all for an empty inbox.
 */

import { describe, expect, test } from 'bun:test'
import { createMailboxClient } from '../../src/peers/mailbox'
import type { Tool } from '../../src/tools/types'

const row = (id: string, content: string) =>
  JSON.stringify(
    { id, thread_id: `t-${id}`, from_agent: 'luna', role: 'request', content, status: 'delivered' },
    null,
    2,
  )

function clientReturning(output: string, calls: Array<Record<string, unknown>> = []) {
  const tool: Tool = {
    definition: { name: 'wald_read_inbox', description: '', parameters: { type: 'object' } },
    async execute(params) {
      calls.push(params)
      return { success: true, output }
    },
  }
  return createMailboxClient({
    lookup: (name) => (name === tool.definition.name ? tool : undefined),
    registry: 'wald',
    selfName: 'kira',
  })
}

describe('readInbox', () => {
  test('several rows', async () => {
    const r = await clientReturning(
      `${row('a', 'one\n{not a row}')}\n${row('b', 'two')}`,
    ).readInbox()
    expect(r.ok && r.value.map((m) => m.id)).toEqual(['a', 'b'])
    expect(r.ok && r.value[0]?.content).toBe('one\n{not a row}')
  })

  test('a single row is a bare object, not an empty inbox', async () => {
    const r = await clientReturning(row('a', 'only')).readInbox()
    expect(r.ok && r.value.map((m) => m.id)).toEqual(['a'])
  })

  test('an empty inbox', async () => {
    const r = await clientReturning('').readInbox()
    expect(r).toEqual({ ok: true, value: [] })
  })

  test('reads its own mailbox by name', async () => {
    const calls: Array<Record<string, unknown>> = []
    await clientReturning('', calls).readInbox()
    expect(calls[0]).toMatchObject({ agent: 'kira', unread_only: true })
  })

  test('a registry that is not connected is an error, not an empty inbox', async () => {
    const client = createMailboxClient({ lookup: () => undefined, registry: 'wald', selfName: 'k' })
    const r = await client.readInbox()
    expect(r.ok).toBe(false)
  })
})
