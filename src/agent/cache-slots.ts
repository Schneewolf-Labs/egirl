/**
 * Session -> KV cache slot assignment for local servers with per-slot prefix caches.
 *
 * Hashing the session id is tempting and wrong: two live sessions can hash to the same
 * slot, and a slot is an exclusive resource on the server side, so the collision
 * serializes two conversations that could have run concurrently — the exact thing the
 * slots exist to avoid. Assigning from a free pool with LRU eviction guarantees no
 * collision while the number of active sessions fits the pool.
 *
 * Eviction costs correctness nothing: the server matches prefixes by token content, so a
 * session landing on a slot that holds someone else's context just re-prefills.
 */
const assigned = new Map<string, number>()
let clock = 0
const touched = new Map<string, number>()

export function slotFor(sessionId: string, slots: number): number | undefined {
  if (!slots || slots < 1) return undefined

  const existing = assigned.get(sessionId)
  if (existing !== undefined && existing < slots) {
    touched.set(sessionId, ++clock)
    return existing
  }

  const inUse = new Set(assigned.values())
  for (let slot = 0; slot < slots; slot++) {
    if (!inUse.has(slot)) {
      assigned.set(sessionId, slot)
      touched.set(sessionId, ++clock)
      return slot
    }
  }

  // Pool exhausted: take the slot of the session that has been idle longest.
  let victim: string | undefined
  let oldest = Number.POSITIVE_INFINITY
  for (const [id, stamp] of touched) {
    if (id === sessionId) continue
    if (stamp < oldest) {
      oldest = stamp
      victim = id
    }
  }
  if (victim === undefined) return 0
  const slot = assigned.get(victim) ?? 0
  assigned.delete(victim)
  touched.delete(victim)
  assigned.set(sessionId, slot)
  touched.set(sessionId, ++clock)
  return slot
}

/** Test/diagnostic helper. */
export function resetSlotAssignments(): void {
  assigned.clear()
  touched.clear()
  clock = 0
}
