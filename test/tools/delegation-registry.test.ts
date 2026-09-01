import { describe, expect, test } from 'bun:test'
import { createDelegationRegistry } from '../../src/tools/delegation-registry'

function begin(steerable = true) {
  const registry = createDelegationRegistry()
  const { id, control } = registry.begin({
    task: 'refactor the parser',
    provider: 'claude',
    workingDir: '/repo',
    steerable,
  })
  return { registry, id, control }
}

describe('delegation registry', () => {
  test('a new delegation is running and listed', () => {
    const { registry, id } = begin()
    const snap = registry.get(id)
    expect(snap?.status).toBe('running')
    expect(snap?.steerable).toBe(true)
    expect(registry.list()).toHaveLength(1)
  })

  test('a queued steer is handed to the next nextSteer call', async () => {
    const { registry, id, control } = begin()
    expect(registry.steer(id, 'use the existing parser')).toBe('sent')
    expect(await control.nextSteer()).toBe('use the existing parser')
  })

  test('a parked nextSteer resolves when a steer arrives', async () => {
    const { registry, id, control } = begin()
    const pending = control.nextSteer()
    registry.steer(id, 'skip the tests for now')
    expect(await pending).toBe('skip the tests for now')
  })

  test('closeSteering refuses while a steer is queued', () => {
    const { registry, id, control } = begin()
    registry.steer(id, 'one more thing')
    // The race that matters: the backend decided to finish in the same tick a correction
    // landed. Closing here would drop it and report the run as a clean success.
    expect(control.closeSteering()).toBe(false)
  })

  test('closeSteering ends the steer channel', async () => {
    const { control } = begin()
    expect(control.closeSteering()).toBe(true)
    expect(await control.nextSteer()).toBeUndefined()
  })

  test('a parked nextSteer resolves undefined once closed', async () => {
    const { control } = begin()
    const pending = control.nextSteer()
    control.closeSteering()
    expect(await pending).toBeUndefined()
  })

  test('steering a finished delegation is refused', () => {
    const { registry, id } = begin()
    registry.settle(id, { success: true, output: 'done' })
    expect(registry.steer(id, 'too late')).toBe('not_running')
  })

  test('steering a backend that cannot take input is refused, not swallowed', () => {
    const { registry, id } = begin(false)
    expect(registry.steer(id, 'change course')).toBe('not_steerable')
  })

  test('steering an unknown id is refused', () => {
    const { registry } = begin()
    expect(registry.steer('nope', 'hello')).toBe('unknown')
  })

  test('stop aborts the control signal and settles as stopped', () => {
    const { registry, id, control } = begin()
    expect(registry.stop(id)).toBe(true)
    expect(control.signal.aborted).toBe(true)
    // The backend reports failure after being killed; the registry knows it was a stop.
    registry.settle(id, { success: false, output: 'Delegation stopped before it finished.' })
    expect(registry.get(id)?.status).toBe('stopped')
  })

  test('stopping a settled delegation does nothing', () => {
    const { registry, id } = begin()
    registry.settle(id, { success: true, output: 'done' })
    expect(registry.stop(id)).toBe(false)
  })

  test('a failed run settles as failed and keeps its output', () => {
    const { registry, id } = begin()
    registry.settle(id, { success: false, output: 'Code agent error: boom' })
    expect(registry.get(id)?.status).toBe('failed')
    expect(registry.output(id)?.result).toContain('boom')
  })

  test('settling twice keeps the first result', () => {
    const { registry, id } = begin()
    registry.settle(id, { success: true, output: 'first' })
    registry.settle(id, { success: false, output: 'second' })
    expect(registry.output(id)?.result).toBe('first')
    expect(registry.takeNotices()).toHaveLength(1)
  })

  test('a completion notice is queued once and drained once', () => {
    const { registry, id } = begin()
    registry.settle(id, { success: true, output: 'refactor complete' })
    const notices = registry.takeNotices()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('refactor complete')
    expect(notices[0]).toContain(id)
    expect(registry.takeNotices()).toHaveLength(0)
  })

  test('a huge result is truncated in the notice but kept whole in the registry', () => {
    const { registry, id } = begin()
    const huge = 'x'.repeat(9000)
    registry.settle(id, { success: true, output: huge })

    const notice = registry.takeNotices()[0] ?? ''
    expect(notice.length).toBeLessThan(6000)
    expect(notice).toContain('code_agent_status')
    expect(registry.output(id)?.result).toHaveLength(9000)
  })

  test('progress is readable incrementally via since_line', () => {
    const { registry, id, control } = begin()
    control.onProgress('→ Read')
    control.onProgress('→ Edit')
    const first = registry.output(id)
    expect(first?.lines).toEqual(['→ Read', '→ Edit'])

    control.onProgress('→ Bash')
    const next = registry.output(id, { sinceLine: first?.nextLine })
    expect(next?.lines).toEqual(['→ Bash'])
  })

  test('blank progress lines are ignored', () => {
    const { registry, id, control } = begin()
    control.onProgress('   \n  ')
    expect(registry.output(id)?.lines).toHaveLength(0)
  })

  test('stats surface before the run ends', () => {
    const { registry, id, control } = begin()
    control.onStats({ costUsd: 0.42, turns: 7 })
    expect(registry.get(id)?.costUsd).toBe(0.42)
    expect(registry.get(id)?.turns).toBe(7)
  })

  test('failing over to a backend that cannot steer drops queued steers loudly', () => {
    const { registry, id } = begin()
    registry.steer(id, 'do it this way')
    registry.setBackend(id, 'codex', false)

    const snap = registry.get(id)
    expect(snap?.provider).toBe('codex')
    expect(snap?.steerable).toBe(false)
    expect(registry.steer(id, 'again')).toBe('not_steerable')
    expect(registry.output(id)?.lines.join('\n')).toContain('dropped 1 steer')
  })

  test('stopAll aborts everything still running', () => {
    const registry = createDelegationRegistry()
    const a = registry.begin({ task: 'a', provider: 'claude', workingDir: '/r', steerable: true })
    const b = registry.begin({ task: 'b', provider: 'claude', workingDir: '/r', steerable: true })
    registry.settle(b.id, { success: true, output: 'done' })

    registry.stopAll()
    expect(a.control.signal.aborted).toBe(true)
    expect(registry.get(b.id)?.status).toBe('done')
  })
})
