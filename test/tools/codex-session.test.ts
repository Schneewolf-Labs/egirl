import { describe, expect, test } from 'bun:test'
import { PermissionSupervisor } from '../../src/permissions/supervisor'
import { runCodexSession } from '../../src/tools/builtin/code-agent/codex'
import type {
  CodexConnection,
  CodexEvents,
  RpcObject,
} from '../../src/tools/builtin/code-agent/codex-rpc'
import type { CodeAgentConfig } from '../../src/tools/builtin/code-agent/types'

function supervisor(action: 'allow' | 'deny' | 'ask_user'): PermissionSupervisor {
  return new PermissionSupervisor({
    config: {
      mode: 'rules_only',
      defaultAction: action,
      thinkBeforeDeciding: false,
      minConfidence: 0,
      askUserBelowConfidence: false,
      memoryRecall: false,
      memoryWrite: false,
      policy: { allow: [], deny: [], askUser: [] },
    },
  })
}
function fixture(
  run: (events: CodexEvents) => void | Promise<void>,
  config: Partial<CodeAgentConfig> = {},
) {
  const requests: { method: string; params: RpcObject }[] = []
  const replies: RpcObject[] = []
  let forced: boolean | undefined
  const promise = runCodexSession(
    { permissionMode: 'default', workingDir: '/project', timeoutMs: 100, ...config },
    'Fix the tests',
    '/project',
    (_cwd, events): CodexConnection => ({
      async request(method, params) {
        requests.push({ method, params })
        if (method === 'thread/start') return { thread: { id: 'thread' } }
        if (method === 'turn/start') {
          events.notification('turn/started', { threadId: 'thread', turn: { id: 'turn' } })
          queueMicrotask(() => {
            void Promise.resolve(run(events)).catch(events.failure)
          })
          return { turn: { id: 'turn' } }
        }
        return {}
      },
      notify() {},
      respond(_id, result) {
        replies.push(result)
      },
      reject(_id, message) {
        replies.push({ error: message })
      },
      async close(force) {
        forced = force
      },
    }),
  )
  return { promise, requests, replies, forced: () => forced }
}
function message(
  events: CodexEvents,
  text = 'The regression now passes.',
  phase = 'final_answer',
): void {
  events.notification('item/completed', {
    threadId: 'thread',
    turnId: 'turn',
    item: { type: 'agentMessage', text, phase },
  })
}
function complete(events: CodexEvents, status = 'completed'): void {
  events.notification('turn/completed', {
    threadId: 'thread',
    turn: { id: 'turn', status, error: { message: 'failure detail' } },
  })
}
const approval = { threadId: 'thread', turnId: 'turn', command: 'run tests' }

describe('Codex structured lifecycle', () => {
  test('ordinary final text completes without terminal magic words', async () => {
    const f = fixture((events) => {
      message(events)
      complete(events)
    })
    expect((await f.promise).success).toBe(true)
    expect(f.forced()).toBe(false)
  })
  test.each(['failed', 'interrupted'])('%s cannot be hidden by Completed text', async (status) => {
    const f = fixture((events) => {
      message(events, '• Completed')
      complete(events, status)
    })
    expect((await f.promise).success).toBe(false)
  })
  test('empty response and commentary alone are not success', async () => {
    for (const text of ['', '• Completed']) {
      const f = fixture((events) => {
        message(events, text, 'commentary')
        complete(events)
      })
      expect((await f.promise).success).toBe(false)
    }
  })
  test('a timeout after Completed text fails and kills the process tree', async () => {
    const f = fixture((events) => message(events, '• Completed'))
    expect((await f.promise).success).toBe(false)
    expect(f.forced()).toBe(true)
  })
  test('early process exit fails even with plausible text', async () => {
    const f = fixture((events) => {
      message(events)
      events.failure(new Error('exited code 0'))
    })
    expect((await f.promise).success).toBe(false)
  })
  test('foreign turn and thread events cannot complete this task', async () => {
    const f = fixture((events) => {
      message(events)
      events.notification('turn/completed', {
        threadId: 'other',
        turn: { id: 'turn', status: 'completed' },
      })
      events.notification('turn/completed', {
        threadId: 'thread',
        turn: { id: 'other', status: 'completed' },
      })
    })
    expect((await f.promise).success).toBe(false)
  })
  test.each([
    'default',
    'plan',
    'bypassPermissions',
  ] as const)('%s sends the correct sandbox', async (permissionMode) => {
    const f = fixture(
      (events) => {
        message(events)
        complete(events)
      },
      { permissionMode },
    )
    await f.promise
    const params = f.requests.find((r) => r.method === 'thread/start')?.params
    expect(params?.sandbox).toBe(
      permissionMode === 'plan'
        ? 'read-only'
        : permissionMode === 'default'
          ? 'workspace-write'
          : 'danger-full-access',
    )
    expect(params?.approvalPolicy).toBe(
      permissionMode === 'bypassPermissions' ? 'never' : 'on-request',
    )
  })
  test.each([
    'allow',
    'deny',
    'ask_user',
  ] as const)('supervisor %s maps explicitly', async (action) => {
    const f = fixture(
      async (events) => {
        await events.request(7, 'item/commandExecution/requestApproval', approval)
        message(events)
        complete(events)
      },
      { permissionSupervisor: supervisor(action) },
    )
    const result = await f.promise
    expect(f.replies[0]?.decision).toBe(action === 'allow' ? 'accept' : 'decline')
    expect(result.success).toBe(action !== 'ask_user')
  })
  test('missing supervisor cannot silently approve', async () => {
    const f = fixture((events) => events.request(7, 'item/fileChange/requestApproval', approval))
    expect((await f.promise).success).toBe(false)
    expect(f.replies[0]?.decision).toBe('decline')
  })
  test('supervisor rejection is caught and fails closed', async () => {
    const broken = supervisor('allow')
    broken.decide = async () => {
      throw new Error('supervisor unavailable')
    }
    const f = fixture(
      (events) => events.request(7, 'item/commandExecution/requestApproval', approval),
      { permissionSupervisor: broken },
    )
    expect((await f.promise).output).toContain('supervisor unavailable')
    expect(f.replies).toHaveLength(0)
  })
  test('unsupported questions are surfaced rather than guessed', async () => {
    const f = fixture((events) =>
      events.request('q1', 'item/tool/requestUserInput', {
        ...approval,
        questions: ['Which project?'],
      }),
    )
    expect((await f.promise).output).toContain('Which project?')
    expect(f.replies[0]?.error).toBeDefined()
  })
  test('uses cancel when decline is not offered', async () => {
    const f = fixture(
      async (events) => {
        await events.request(7, 'item/commandExecution/requestApproval', {
          ...approval,
          availableDecisions: ['accept', 'cancel'],
        })
        complete(events, 'interrupted')
      },
      { permissionSupervisor: supervisor('deny') },
    )
    expect((await f.promise).success).toBe(false)
    expect(f.replies[0]?.decision).toBe('cancel')
  })
  test('never sends an acceptance that was not offered', async () => {
    const f = fixture(
      async (events) => {
        await events.request(7, 'item/commandExecution/requestApproval', {
          ...approval,
          availableDecisions: ['cancel'],
        })
        complete(events, 'interrupted')
      },
      { permissionSupervisor: supervisor('allow') },
    )
    await f.promise
    expect(f.replies[0]?.decision).toBe('cancel')
  })
  test('late supervisor approval cannot revive a timed-out task', async () => {
    const delayed = supervisor('allow')
    let approve: (() => void) | undefined
    delayed.decide = () =>
      new Promise((resolve) => {
        approve = () => resolve({ action: 'allow', reason: 'late', confidence: 1 })
      })
    const f = fixture(
      (events) => events.request(7, 'item/commandExecution/requestApproval', approval),
      { permissionSupervisor: delayed },
    )
    expect((await f.promise).success).toBe(false)
    approve?.()
    await Promise.resolve()
    expect(f.replies).toHaveLength(0)
  })
})
