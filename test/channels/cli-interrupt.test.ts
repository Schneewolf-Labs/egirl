import { describe, expect, test } from 'bun:test'
import { interruptCommand } from '../../src/channels/cli-interrupt'
import type { Operator } from '../../src/operator/types'
import { SessionController } from '../../src/session/controller'

function operator(canInject: boolean, injected: string[] = []): Operator {
  return {
    inject(message: string) {
      if (canInject) injected.push(message)
      return canInject
    },
  } as unknown as Operator
}

function running(...queued: string[]): SessionController {
  const session = new SessionController()
  session.begin()
  for (const q of queued) session.enqueue(q)
  return session
}

describe('/interrupt', () => {
  test('sends everything queued into the running turn', () => {
    const injected: string[] = []
    const session = running('stop', 'use the other binary')
    const out = interruptCommand('', { agent: operator(true, injected), session })
    expect(injected).toEqual(['stop\nuse the other binary'])
    expect(out).toContain('sent 2 queued messages into this turn')
    expect(session.peek()).toHaveLength(0)
  })

  test('a count sends only the oldest n and leaves the rest queued', () => {
    const injected: string[] = []
    const session = running('a', 'b', 'c')
    const out = interruptCommand(' 2', { agent: operator(true, injected), session })
    expect(injected).toEqual(['a\nb'])
    expect(out).toContain('1 still queued')
    expect(session.peek().map((m) => m.text)).toEqual(['c'])
  })

  test('an operator that cannot inject stops the turn and sends them next, on their own', () => {
    const session = running('a', 'b', 'c')
    const signal = session.begin()
    const out = interruptCommand('1', { agent: operator(false), session })
    expect(signal.aborted).toBe(true)
    expect(out).toContain('interrupting')
    expect(session.drain()).toBe('a')
    expect(session.drain()).toBe('b\nc')
  })

  test('nothing running, nothing queued, or a bad count says so', () => {
    const idle = new SessionController()
    expect(interruptCommand('', { agent: operator(true), session: idle })).toContain(
      'Nothing is running',
    )
    expect(interruptCommand('', { agent: operator(true), session: running() })).toContain(
      'Nothing queued',
    )
    for (const bad of ['0', '-1', 'x', '1.5']) {
      expect(interruptCommand(bad, { agent: operator(true), session: running('a') })).toContain(
        'takes a count',
      )
    }
  })
})
