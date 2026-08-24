/**
 * The mutex's busy signal, which the peer protocol uses to fast-path "I'm mid-task" instead of
 * making a supervisor wait out a turn that can take minutes.
 */

import { describe, expect, test } from 'bun:test'
import { SessionMutex } from '../../src/agent/session-mutex'

describe('SessionMutex.isBusy', () => {
  test('is false when idle, true while a run holds the lock', async () => {
    const m = new SessionMutex()
    expect(m.isBusy()).toBe(false)
    await m.acquire()
    // A second run would now have to queue — which is exactly what "busy" reports.
    expect(m.isBusy()).toBe(true)
    m.release()
    expect(m.isBusy()).toBe(false)
  })
})
