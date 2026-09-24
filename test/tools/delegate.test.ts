/**
 * delegate — hand work to another agent through the Wald mailbox without waiting.
 *
 * From a task it parks the run (the same awaiting state as an unanswered report ask). The
 * delegation is recorded before the send, so no answer can arrive for a thread with no record.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MailboxClient } from '../../src/peers/mailbox'
import { createMailboxStore, type MailboxStore } from '../../src/peers/mailbox-store'
import { createDelegateTool } from '../../src/tools/builtin/delegate'

let store: MailboxStore
beforeEach(() => {
  store = createMailboxStore(join(mkdtempSync(join(tmpdir(), 'egirl-delegate-')), 'mailbox.db'))
})

function client(onSend: (threadId: string | undefined) => boolean): MailboxClient {
  return {
    async send({ threadId }) {
      return onSend(threadId)
        ? { ok: true, value: { messageId: 'm1', threadId: threadId ?? 'x' } }
        : { ok: false, error: "target agent 'nobody' is not registered" }
    },
    async readInbox() {
      return { ok: true, value: [] }
    },
    async ack() {
      return { ok: true, value: 0 }
    },
  }
}

describe('delegate', () => {
  test('from a task: recorded before the send, and the run parks', async () => {
    let recordedAtSend = false
    const tool = createDelegateTool({
      store,
      client: client((threadId) => {
        recordedAtSend = !!threadId && store.getDelegation(threadId)?.agent === 'scribe'
        return true
      }),
    })

    const result = await tool.execute({ agent: 'scribe', message: 'summarize it' }, '/tmp', {
      sessionId: 'task:abc',
    })

    expect(recordedAtSend).toBe(true)
    expect(result.success).toBe(true)
    expect(result.awaitingInput).toBe(true)
  })

  test('from a conversation: sent, and the run carries on', async () => {
    const tool = createDelegateTool({ store, client: client(() => true) })
    const result = await tool.execute({ agent: 'scribe', message: 'x' }, '/tmp', {
      sessionId: 'api:default',
    })
    expect(result.success).toBe(true)
    expect(result.awaitingInput).toBeUndefined()
  })

  test('a failed send leaves no delegation behind', async () => {
    let thread: string | undefined
    const tool = createDelegateTool({
      store,
      client: client((threadId) => {
        thread = threadId
        return false
      }),
    })
    const result = await tool.execute({ agent: 'nobody', message: 'x' }, '/tmp', {
      sessionId: 'task:abc',
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('not registered')
    expect(store.getDelegation(thread as string)).toBeUndefined()
  })

  test('without a session there is nowhere to route the answer', async () => {
    const tool = createDelegateTool({ store, client: client(() => true) })
    const result = await tool.execute({ agent: 'scribe', message: 'x' }, '/tmp')
    expect(result.success).toBe(false)
  })
})
