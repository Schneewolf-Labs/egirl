/**
 * Session -> KV cache slot assignment.
 *
 * The contract these pin down: two live sessions never share a slot while the pool has
 * room (a collision serializes conversations the slots exist to parallelize), a session
 * keeps its slot across calls (that stability is the whole prefix-cache win), and when
 * the pool runs out the session idle longest loses its slot — never an active one.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { resetSlotAssignments, slotFor } from '../../src/agent/cache-slots'

beforeEach(() => {
  resetSlotAssignments()
})

describe('slotFor', () => {
  test('no configured slots means no slot at all', () => {
    expect(slotFor('a', 0)).toBeUndefined()
    expect(slotFor('a', -1)).toBeUndefined()
  })

  test('a session keeps the same slot across calls', () => {
    const first = slotFor('a', 4)
    expect(first).toBeDefined()
    expect(slotFor('a', 4)).toBe(first as number)
    expect(slotFor('a', 4)).toBe(first as number)
  })

  test('live sessions never collide while the pool has room', () => {
    const slots = ['a', 'b', 'c', 'd'].map((id) => slotFor(id, 4))
    const distinct = new Set(slots)
    expect(distinct.size).toBe(4)
    for (const slot of slots) {
      expect(slot).toBeGreaterThanOrEqual(0)
      expect(slot).toBeLessThan(4)
    }
  })

  test('an exhausted pool evicts the session idle longest, not an active one', () => {
    const slotA = slotFor('a', 2)
    const slotB = slotFor('b', 2)
    // Touch a so b becomes the least recently used.
    slotFor('a', 2)

    const slotC = slotFor('c', 2)
    // c takes b's slot; a is untouched.
    expect(slotC).toBe(slotB as number)
    expect(slotFor('a', 2)).toBe(slotA as number)
  })

  test('an evicted session coming back gets a slot again', () => {
    slotFor('a', 2)
    slotFor('b', 2)
    slotFor('a', 2) // b is now LRU
    slotFor('c', 2) // evicts b

    const back = slotFor('b', 2)
    expect(back).toBeDefined()
    expect(back).toBeGreaterThanOrEqual(0)
    expect(back).toBeLessThan(2)
  })

  test('a stale assignment outside a shrunken pool is reassigned within it', () => {
    slotFor('a', 3)
    slotFor('b', 3)
    const slotC = slotFor('c', 3)
    expect(slotC).toBe(2)

    // The server was reconfigured down to 2 slots: c's old slot no longer exists.
    const reassigned = slotFor('c', 2)
    expect(reassigned).toBeDefined()
    expect(reassigned).toBeLessThan(2)
  })

  test('reset clears every assignment', () => {
    slotFor('a', 2)
    slotFor('b', 2)
    resetSlotAssignments()
    // A fresh session starts from slot 0 again — nothing survived the reset.
    expect(slotFor('z', 2)).toBe(0)
  })
})
