/**
 * Stopping an XMPP client that never came online.
 *
 * This looks like a triviality and was not. `stop()` announced departure before shutting the
 * client down, and sending presence on a client that never connected rejects — which skipped the
 * shutdown entirely and left the client's own reconnect loop running. The visible symptom was an
 * instance logging a connection error every second, forever, for a failure that could not
 * resolve on its own (a self-signed certificate is still self-signed a second later).
 *
 * Shutdown paths have to work in the state you reach them from, and the state you reach a
 * shutdown from is usually "something already went wrong".
 */

import { describe, expect, test } from 'bun:test'
import { XMPPChannel } from '../../src/channels/xmpp'

/** A stand-in for @xmpp/client that records calls and rejects sends while offline. */
function fakeClient(status: string) {
  const calls: string[] = []
  return {
    calls,
    client: {
      status,
      on() {},
      async send() {
        calls.push('send')
        if (status !== 'online') throw new Error('not connected')
      },
      async stop() {
        calls.push('stop')
      },
      async start() {
        calls.push('start')
      },
    },
  }
}

function channelWith(client: unknown): XMPPChannel {
  const channel = Object.create(XMPPChannel.prototype) as XMPPChannel & {
    xmpp: unknown
    config: unknown
  }
  channel.xmpp = client
  channel.config = { allowedJids: [], service: 'xmpps://127.0.0.1:5223' }
  return channel
}

describe('XMPPChannel.stop', () => {
  test('shuts the client down even when it never connected', async () => {
    // The regression: the failed presence send used to throw straight out of stop(), so
    // xmpp.stop() never ran and the reconnect loop kept going for the life of the process.
    const { calls, client } = fakeClient('offline')
    await channelWith(client).stop()
    expect(calls).toContain('stop')
  })

  test('still says goodbye when it is actually online', async () => {
    const { calls, client } = fakeClient('online')
    await channelWith(client).stop()
    expect(calls).toEqual(['send', 'stop'])
  })
})
