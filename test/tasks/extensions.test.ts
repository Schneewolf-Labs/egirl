import { describe, expect, test } from 'bun:test'
import { RunDeadline } from '../../src/tasks/deadline'
import {
  decideExtension,
  isArtifactAction,
  MIN_DISTINCT_CALLS,
  ProgressTracker,
} from '../../src/tasks/extensions'

const policy = { budgetMs: 60 * 60_000, maxExtensions: 2, maxExtensionRatio: 1 }
const progress = { distinctCalls: MIN_DISTINCT_CALLS, artifactActions: 0, repeatTrips: 0 }

describe('decideExtension', () => {
  test('grants the requested time on enough distinct calls', () => {
    const d = decideExtension({
      requestedMinutes: 20,
      evidence: progress,
      grantsSoFar: 0,
      extendedMsSoFar: 0,
      policy,
    })
    expect(d.verdict).toBe('granted')
    expect(d.grantedMs).toBe(20 * 60_000)
    expect(d.remainingCapMs).toBe(40 * 60_000)
  })

  test('clips a grant to what the total cap has left', () => {
    const d = decideExtension({
      requestedMinutes: 30,
      evidence: progress,
      grantsSoFar: 1,
      extendedMsSoFar: 50 * 60_000,
      policy,
    })
    expect(d.grantedMs).toBe(10 * 60_000)
  })

  test('denies: no progress, repeat trip, count cap, time cap, nonsense minutes', () => {
    const base = { requestedMinutes: 10, grantsSoFar: 0, extendedMsSoFar: 0, policy }
    const none = { distinctCalls: MIN_DISTINCT_CALLS - 1, artifactActions: 0, repeatTrips: 0 }
    expect(decideExtension({ ...base, evidence: none }).verdict).toBe('no_progress')
    expect(decideExtension({ ...base, evidence: { ...progress, repeatTrips: 1 } }).verdict).toBe(
      'repeating',
    )
    expect(decideExtension({ ...base, evidence: progress, grantsSoFar: 2 }).verdict).toBe(
      'cap_reached',
    )
    expect(
      decideExtension({ ...base, evidence: progress, extendedMsSoFar: 60 * 60_000 }).verdict,
    ).toBe('cap_reached')
    expect(decideExtension({ ...base, evidence: progress, requestedMinutes: -5 }).verdict).toBe(
      'invalid',
    )
  })

  test('one artifact action is enough on its own', () => {
    const d = decideExtension({
      requestedMinutes: 5,
      evidence: { distinctCalls: 1, artifactActions: 1, repeatTrips: 0 },
      grantsSoFar: 0,
      extendedMsSoFar: 0,
      policy,
    })
    expect(d.verdict).toBe('granted')
  })
})

describe('progress evidence', () => {
  test('artifact actions: file writes, commits, and shell git commit/push', () => {
    expect(isArtifactAction('write_file', '{}')).toBe(true)
    expect(isArtifactAction('edit_file', '{}')).toBe(true)
    expect(isArtifactAction('git_commit', '{}')).toBe(true)
    expect(isArtifactAction('execute_command', '{"command":"git commit -am wip"}')).toBe(true)
    expect(isArtifactAction('execute_command', '{"command":"git -C repo push origin x"}')).toBe(
      true,
    )
    expect(isArtifactAction('execute_command', '{"command":"git status"}')).toBe(false)
    expect(isArtifactAction('read_file', '{}')).toBe(false)
  })

  test('only distinct successful work counts, and a checkpoint starts a new window', () => {
    const t = new ProgressTracker()
    t.recordTool('noop', '{"n":1}', true)
    t.recordTool('noop', '{"n":1}', true)
    t.recordTool('noop', '{"n":2}', false)
    t.recordTool('request_extension', '{}', true)
    t.recordRepeat()
    expect(t.snapshot()).toEqual({ distinctCalls: 1, artifactActions: 0, repeatTrips: 1 })
    t.checkpoint()
    expect(t.snapshot()).toEqual({ distinctCalls: 0, artifactActions: 0, repeatTrips: 0 })
  })
})

describe('RunDeadline', () => {
  test('an extension moves the abort and the expiry', async () => {
    let aborted = 0
    const deadline = new RunDeadline(100, () => aborted++)
    const firstAt = deadline.at
    expect(deadline.extend(300)).toBe(true)
    expect(deadline.at).toBe(firstAt + 300)
    await Bun.sleep(200)
    expect(aborted).toBe(0)
    // Settle first, then assert: `await expect(pending).rejects` hangs bun test on Windows.
    const err = await deadline.expired.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('Task timed out after 400ms')
    expect(aborted).toBe(1)
    expect(deadline.extend(100)).toBe(false)
  })
})
