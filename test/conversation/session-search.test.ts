/**
 * FTS5 search over past conversations, and the session_search tool on top of it.
 *
 * The sanitization tests matter most: the query comes from a model, and FTS5's grammar
 * rejects half of ordinary punctuation outside a quoted phrase. A search tool that throws on
 * `header(0x04)` would train the agent to stop using it.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../../src/conversation/store'
import { createSessionSearchTool } from '../../src/tools/builtin/session-search'

const stores: ConversationStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})

function makeStore(): ConversationStore {
  const dir = mkdtempSync(join(tmpdir(), 'search-'))
  const store = new ConversationStore(join(dir, 'conv.db'))
  stores.push(store)
  return store
}

function seed(store: ConversationStore): void {
  store.appendMessages('cli:rfh', [
    { role: 'user', content: 'what did the hexdump of resource.RFH show?' },
    { role: 'assistant', content: 'The RFH header starts with a u32 name length at offset 4.' },
    { role: 'tool', content: '<tool_response>00000000 07 00 00 00</tool_response>' },
  ])
  store.appendMessages('web:vram', [
    { role: 'assistant', content: 'Free VRAM was 7856 MiB on the A6000 after loading wichtel.' },
  ])
}

describe('searchMessages', () => {
  test('finds content across sessions', () => {
    const store = makeStore()
    seed(store)
    const hits = store.searchMessages('RFH header offset')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.sessionId).toBe('cli:rfh')
    expect(hits[0]?.snippet).toContain('»')
  })

  test('tool plumbing rows are not returned', () => {
    const store = makeStore()
    seed(store)
    const hits = store.searchMessages('tool_response')
    expect(hits).toHaveLength(0)
  })

  test('FTS5 grammar characters in the query cannot cause an error', () => {
    const store = makeStore()
    seed(store)
    // Every character class hermes's sanitizer guards against, in one query.
    const hostile = 'header(0x04) + "name" AND {length} ^ | ~ * : offset'
    expect(() => store.searchMessages(hostile)).not.toThrow()
    // And the legitimate terms inside it still match via the OR fallback.
    expect(store.searchMessages(hostile).length).toBeGreaterThan(0)
  })

  test('an empty or symbols-only query returns nothing rather than everything', () => {
    const store = makeStore()
    seed(store)
    expect(store.searchMessages('')).toHaveLength(0)
    expect(store.searchMessages('+++ ((( "')).toHaveLength(0)
  })

  test('a pre-existing database is backfilled on reopen', () => {
    // Simulate a store whose rows predate the index: write, drop the index tables the way an
    // old database simply would not have them, reopen, and expect search to work.
    const dir = mkdtempSync(join(tmpdir(), 'search-backfill-'))
    const path = join(dir, 'conv.db')
    const first = new ConversationStore(path)
    first.appendMessages('old:session', [{ role: 'assistant', content: 'the schneewolf plan' }])
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the db to simulate an old file
    const db = (first as any).db
    db.run('DROP TRIGGER messages_fts_ai')
    db.run('DROP TRIGGER messages_fts_ad')
    db.run('DROP TABLE messages_fts')
    first.close()

    const reopened = new ConversationStore(path)
    stores.push(reopened)
    expect(reopened.searchMessages('schneewolf').length).toBe(1)
  })
})

describe('session_search tool', () => {
  test('formats hits with session and age', async () => {
    const store = makeStore()
    seed(store)
    const tool = createSessionSearchTool(store)
    const result = await tool.execute({ query: 'VRAM A6000' }, '/tmp')
    expect(result.success).toBe(true)
    expect(result.output).toContain('[web:vram')
    expect(result.output).toContain('7856')
  })

  test('no matches is a normal result, not an error', async () => {
    const store = makeStore()
    const tool = createSessionSearchTool(store)
    const result = await tool.execute({ query: 'nothing like this exists' }, '/tmp')
    expect(result.success).toBe(true)
    expect(result.output).toContain('No past-conversation matches')
  })
})

describe('registration', () => {
  test('session_search is offered when a conversation store exists', async () => {
    // The tool worked in isolation while never being registered -- Zero reported "my tool
    // list has no session_search" in production. This pins the actual wiring.
    const { createDefaultToolExecutor } = await import('../../src/tools/index')
    const { makeConfig, makeWorkspace } = await import('../agent/helpers')
    const store = makeStore()
    const executor = createDefaultToolExecutor(
      makeConfig(makeWorkspace()),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    )
    const names = executor.getDefinitions().map((d) => d.name)
    expect(names).toContain('session_search')
  })

  test('absent store, absent tool', async () => {
    const { createDefaultToolExecutor } = await import('../../src/tools/index')
    const { makeConfig, makeWorkspace } = await import('../agent/helpers')
    const executor = createDefaultToolExecutor(makeConfig(makeWorkspace()))
    expect(executor.getDefinitions().map((d) => d.name)).not.toContain('session_search')
  })
})
