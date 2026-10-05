import type { AgentApp, AnyMessage, Stream } from '@agentclientprotocol/sdk'
import type { AcpConnect, AcpTransport } from '../../src/tools/builtin/code-agent/acp-process'

/** Two ends of an in-process ACP connection: what one side writes, the other reads. */
export function streamPair(): { client: Stream; agent: Stream } {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>()
  const toClient = new TransformStream<AnyMessage, AnyMessage>()
  return {
    client: { writable: toAgent.writable, readable: toClient.readable },
    agent: { writable: toClient.writable, readable: toAgent.readable },
  }
}

export interface FakeSpawn {
  connect: AcpConnect
  /** The command and cwd the backend asked to spawn, and how it closed the agent. */
  spawned: { command: string[]; cwd: string }[]
  closes: boolean[]
}

/** An AcpConnect that "spawns" an in-process agent app instead of a process. */
export function inProcess(makeAgent: () => AgentApp): FakeSpawn {
  const spawned: FakeSpawn['spawned'] = []
  const closes: boolean[] = []
  const connect: AcpConnect = (command, cwd): AcpTransport => {
    spawned.push({ command, cwd })
    const { client, agent } = streamPair()
    const connection = makeAgent().connect(agent)
    return {
      stream: client,
      stderr: () => '',
      async close(force) {
        closes.push(force)
        connection.close()
      },
    }
  }
  return { connect, spawned, closes }
}
