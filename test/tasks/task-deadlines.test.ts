/**
 * Task deadlines: a bounded run that hits its time limit is continued on retry instead of
 * redone, an extension is granted only on evidence of progress (and really moves the deadline),
 * and end_task stops a run cleanly with the status the agent declared.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../../src/agent/loop'
import { createConversationStore } from '../../src/conversation'
import type { ChatRequest, ChatResponse, LLMProvider } from '../../src/providers/types'
import { createTaskRunner, type TaskRunner } from '../../src/tasks/runner'
import { createTaskStore, type TaskStore } from '../../src/tasks/store'
import type { TasksConfig } from '../../src/tasks/types'
import { createToolExecutor } from '../../src/tools/executor'
import type { Tool } from '../../src/tools/types'
import { setTraceStore, TraceStore } from '../../src/tracking/traces'
import { makeConfig, stubResponse } from '../agent/helpers'

/** One scripted model turn: a response, optionally after a delay that ignores the abort. */
interface Step {
  response: Partial<ChatResponse>
  delayMs?: number
}

interface Recorded {
  messages: string
  tools: string[]
}

function scripted(steps: Step[], seen: Recorded[]): LLMProvider {
  let n = 0
  return {
    name: 'stub',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      seen.push({
        messages: JSON.stringify(req.messages),
        tools: (req.tools ?? []).map((t) => t.name),
      })
      const step = steps[Math.min(n++, steps.length - 1)]
      if (step?.delayMs) await new Promise((r) => setTimeout(r, step.delayMs))
      return stubResponse(step?.response ?? { content: 'done' })
    },
  }
}

const call = (name: string, args: Record<string, unknown>, id = `${name}-${Math.random()}`) => ({
  response: {
    tool_calls: [{ id, name, arguments: args }],
    finish_reason: 'tool_calls' as const,
  },
})

const noopTool: Tool = {
  definition: {
    name: 'noop',
    description: 'does nothing',
    parameters: { type: 'object', properties: {} },
  },
  execute: async () => ({ success: true, output: 'noop ok' }),
}

const reportTool: Tool = {
  definition: {
    name: 'report',
    description: 'stub report',
    parameters: { type: 'object', properties: {} },
  },
  execute: async () => ({ success: true, output: 'reported' }),
}

interface Harness {
  runner: TaskRunner
  store: TaskStore
  workspace: string
}

function makeRunner(opts: {
  provider: LLMProvider
  timeoutMs?: number
  conversations?: boolean
  tools?: Tool[]
  tasks?: Partial<TasksConfig>
}): Harness {
  const workspace = mkdtempSync(join(tmpdir(), 'egirl-deadlines-'))
  const config = makeConfig(workspace)
  const store = createTaskStore(join(workspace, 'tasks.db'))
  const executor = createToolExecutor()
  for (const tool of opts.tools ?? [noopTool]) executor.register(tool)
  const runner = createTaskRunner({
    config,
    tasksConfig: {
      ...config.tasks,
      taskTimeoutMs: opts.timeoutMs ?? 300_000,
      ...opts.tasks,
    },
    store,
    toolExecutor: executor,
    localProvider: opts.provider,
    memory: undefined,
    outbound: new Map(),
    ...(opts.conversations !== false && {
      conversationStore: createConversationStore(join(workspace, 'conversations.db')),
    }),
  })
  return { runner, store, workspace }
}

function createTask(
  store: TaskStore,
  kind: 'oneshot' | 'scheduled' = 'oneshot',
  extra: { unbounded?: boolean } = {},
) {
  return store.create({
    name: `t-${kind}`,
    description: 'deadline test',
    kind,
    prompt: 'BUILD THE DELIVERABLE',
    ...(kind === 'scheduled' && { intervalMs: 3_600_000 }),
    ...extra,
    channel: 'api',
    channelTarget: 'api:default',
    createdBy: 'user',
  })
}

/** Wait until the task's execution (not just the runner's race) has ended. */
async function settled(runner: TaskRunner, taskId: string): Promise<void> {
  for (let i = 0; i < 400 && runner.getRunningTaskIds().includes(taskId); i++) await Bun.sleep(10)
}

/** The tool result the model saw for its last request_extension call, from a later request. */
function lastToolResult(seen: Recorded[], marker: string): string {
  for (let i = seen.length - 1; i >= 0; i--) {
    const messages = JSON.parse(seen[i]?.messages ?? '[]') as Array<{
      role: string
      content: unknown
    }>
    const hit = [...messages]
      .reverse()
      .find((m) => m.role === 'tool' && String(m.content).includes(marker))
    if (hit) return String(hit.content)
  }
  return ''
}

const RESUME = 'hit its time limit after'

describe('bounded timeout: resume, not restart', () => {
  test('the retry continues the persisted conversation, opened by the resume note', async () => {
    const seen: Recorded[] = []
    const provider = scripted(
      [
        call('noop', { step: 'wrote-the-file' }),
        // Overruns the budget: the run is stopped mid-way.
        { response: { content: 'never seen' }, delayMs: 1600 },
        // The retry.
        { response: { content: 'continued and finished' } },
      ],
      seen,
    )
    const { runner, store } = makeRunner({ provider, timeoutMs: 800 })
    const task = createTask(store)

    const first = await runner.runNow(task.id)
    expect(first?.status).toBe('failure')
    expect(store.get(task.id)?.lastErrorKind).toBe('timeout')
    await settled(runner, task.id)

    const retry = await runner.runNow(task.id)
    expect(retry?.status).toBe('success')
    expect(retry?.result).toBe('continued and finished')

    const retryRequest = seen[2]?.messages ?? ''
    // The first run's work is in the window, the run opens on the note, not on the prompt again.
    expect(retryRequest).toContain('noop ok')
    expect(retryRequest).toContain(RESUME)
    expect(retryRequest.split('BUILD THE DELIVERABLE').length - 1).toBe(1)
    const msgs = JSON.parse(retryRequest) as Array<{ role: string; content: string }>
    expect(msgs.filter((m) => m.role === 'user').at(-1)?.content).toContain(RESUME)
  })

  test('with no persisted conversation, the retry falls back to a fresh run', async () => {
    const seen: Recorded[] = []
    const provider = scripted(
      [
        call('noop', { step: 1 }),
        { response: { content: 'never seen' }, delayMs: 1600 },
        { response: { content: 'fresh' } },
      ],
      seen,
    )
    const { runner, store } = makeRunner({ provider, timeoutMs: 800, conversations: false })
    const task = createTask(store)

    expect((await runner.runNow(task.id))?.status).toBe('failure')
    await settled(runner, task.id)
    expect((await runner.runNow(task.id))?.status).toBe('success')

    const retryRequest = seen[2]?.messages ?? ''
    expect(retryRequest).not.toContain(RESUME)
    expect(retryRequest).not.toContain('noop ok')
    expect(retryRequest).toContain('BUILD THE DELIVERABLE')
  })

  test('a fresh run of a non-persisting task does not inherit the last transcript', async () => {
    const seen: Recorded[] = []
    const provider = scripted(
      [
        call('noop', { step: 1 }),
        { response: { content: 'one' } },
        { response: { content: 'two' } },
      ],
      seen,
    )
    const { runner, store } = makeRunner({ provider })
    const task = createTask(store, 'scheduled')

    expect((await runner.runNow(task.id))?.status).toBe('success')
    expect((await runner.runNow(task.id))?.status).toBe('success')
    expect(seen[2]?.messages).not.toContain('noop ok')
  })
})

describe('request_extension', () => {
  let traceDir: string
  let traces: TraceStore

  beforeEach(() => {
    traceDir = mkdtempSync(join(tmpdir(), 'egirl-deadline-traces-'))
    traces = new TraceStore(join(traceDir, 'traces.db'), 'verbose', 14)
    setTraceStore(traces)
  })
  afterEach(() => {
    setTraceStore(null)
  })

  const ask = (minutes = 1) =>
    call('request_extension', { minutes, reason: 'tests left', remaining: 'run tests' })

  test('granted after real progress, and the deadline actually moves', async () => {
    const seen: Recorded[] = []
    const provider = scripted(
      [
        call('noop', { n: 1 }),
        call('noop', { n: 2 }),
        call('noop', { n: 3 }),
        ask(),
        // Runs past the original 1 s budget, well inside the granted 3 s.
        { response: { content: 'finished late' }, delayMs: 1500 },
      ],
      seen,
    )
    const { runner, store } = makeRunner({
      provider,
      timeoutMs: 1000,
      tasks: { maxExtensionRatio: 3 },
    })
    const task = createTask(store)

    const run = await runner.runNow(task.id)
    expect(lastToolResult(seen, 'Extension')).toContain('Extension granted')
    expect(run?.status).toBe('success')
    expect(run?.result).toBe('finished late')

    const rows = traces.query({ kind: 'decision' })
    expect(rows.length).toBe(1)
    const payload = JSON.parse(rows[0]?.payload ?? '{}')
    expect(payload.verdict).toBe('granted')
    expect(payload.distinct_calls).toBe(3)
    expect(payload.granted_ms).toBe(3000)
  })

  test('denied without progress', async () => {
    const seen: Recorded[] = []
    const provider = scripted([ask(30), { response: { content: 'ok' } }], seen)
    const { runner, store } = makeRunner({ provider })
    await runner.runNow(createTask(store).id)

    const result = lastToolResult(seen, 'Extension')
    expect(result).toContain('not enough measurable progress')
    expect(result).toContain('end_task')
    expect(JSON.parse(traces.query({ kind: 'decision' })[0]?.payload ?? '{}').verdict).toBe(
      'no_progress',
    )
  })

  test('an artifact action alone counts as progress', async () => {
    const writeTool: Tool = {
      definition: { name: 'write_file', description: 'w', parameters: { type: 'object' } },
      execute: async () => ({ success: true, output: 'written' }),
    }
    const seen: Recorded[] = []
    const provider = scripted(
      [call('write_file', { path: 'a.txt' }), ask(), { response: { content: 'ok' } }],
      seen,
    )
    const { runner, store } = makeRunner({ provider, tools: [writeTool] })
    await runner.runNow(createTask(store).id)
    expect(lastToolResult(seen, 'Extension')).toContain('Extension granted')
  })

  test('denied once the cap is reached, pointing at report(mode=ask)', async () => {
    const seen: Recorded[] = []
    const provider = scripted(
      [
        call('noop', { n: 1 }),
        call('noop', { n: 2 }),
        call('noop', { n: 3 }),
        ask(),
        call('noop', { n: 4 }),
        call('noop', { n: 5 }),
        call('noop', { n: 6 }),
        ask(2),
        { response: { content: 'ok' } },
      ],
      seen,
    )
    const { runner, store } = makeRunner({
      provider,
      tools: [noopTool, reportTool],
      tasks: { maxExtensions: 1 },
    })
    await runner.runNow(createTask(store).id)

    const result = lastToolResult(seen, 'Extension')
    expect(result).toContain('limit for this run is reached')
    expect(result).toContain('report(mode=ask)')
    const verdicts = traces
      .query({ kind: 'decision' })
      .map((r) => JSON.parse(r.payload ?? '{}').verdict)
      .sort()
    expect(verdicts).toEqual(['cap_reached', 'granted'])
  })

  test('denied when the total time cap is spent, even under max_extensions', async () => {
    const seen: Recorded[] = []
    const provider = scripted(
      [
        call('noop', { n: 1 }),
        call('noop', { n: 2 }),
        call('noop', { n: 3 }),
        // Asks for far more than the budget: clipped to budget × ratio.
        ask(100_000),
        call('noop', { n: 4 }),
        call('noop', { n: 5 }),
        call('noop', { n: 6 }),
        ask(),
        { response: { content: 'ok' } },
      ],
      seen,
    )
    const { runner, store } = makeRunner({ provider })
    await runner.runNow(createTask(store).id)
    expect(lastToolResult(seen, 'Extension')).toContain('limit for this run is reached')
    // No report tool registered: no pointer to it.
    expect(lastToolResult(seen, 'Extension')).not.toContain('report(mode=ask)')
  })

  test('a repeat-detector trip in the window denies', async () => {
    const seen: Recorded[] = []
    const provider = scripted(
      [
        call('noop', { n: 1 }),
        call('noop', { n: 1 }), // same call, back to back: a loop
        call('noop', { n: 2 }),
        call('noop', { n: 3 }),
        ask(),
        { response: { content: 'ok' } },
      ],
      seen,
    )
    const { runner, store } = makeRunner({ provider })
    await runner.runNow(createTask(store).id)
    expect(lastToolResult(seen, 'Extension')).toContain('repeated the same tool call')
  })
})

describe('end_task', () => {
  const end = (status: string, summary: string) => call('end_task', { status, summary })

  test('done: the run succeeds with the summary, and no further turns follow', async () => {
    const seen: Recorded[] = []
    const provider = scripted(
      [end('done', 'Shipped it.'), { response: { content: 'should never run' } }],
      seen,
    )
    const { runner, store } = makeRunner({ provider })
    const task = createTask(store)
    const run = await runner.runNow(task.id)

    expect(run?.status).toBe('success')
    expect(run?.result).toBe('Shipped it.')
    expect(seen.length).toBe(1)
    expect(store.get(task.id)?.status).toBe('done')
  })

  test('blocked: completes with a blocked result, oneshot paused and not retried', async () => {
    const seen: Recorded[] = []
    const provider = scripted([end('blocked', 'Need the API key.')], seen)
    const { runner, store } = makeRunner({ provider })
    const task = createTask(store)
    const run = await runner.runNow(task.id)

    expect(run?.status).toBe('success')
    expect(run?.result).toBe('[Blocked] Need the API key.')
    const after = store.get(task.id)
    expect(after?.status).toBe('paused')
    expect(after?.nextRunAt).toBeUndefined()
    expect(store.getTransitions(task.id).some((t) => t.reason?.startsWith('Blocked:'))).toBe(true)
  })

  test('abandoned: a failure that is never retried', async () => {
    const provider = scripted([end('abandoned', 'Wrong repo; nothing to do.')], [])
    const { runner, store } = makeRunner({ provider })
    const task = createTask(store)
    const run = await runner.runNow(task.id)

    expect(run?.status).toBe('failure')
    expect(run?.error).toBe('Abandoned: Wrong repo; nothing to do.')
    const after = store.get(task.id)
    expect(after?.status).toBe('failed')
    expect(after?.nextRunAt).toBeUndefined()
  })

  test('abandoned on a scheduled task waits for its next regular run, no backoff retry', async () => {
    const provider = scripted([end('abandoned', 'Not today.')], [])
    const { runner, store } = makeRunner({ provider })
    const task = createTask(store, 'scheduled')
    const before = Date.now()
    await runner.runNow(task.id)

    const after = store.get(task.id)
    expect(after?.status).toBe('active')
    expect(after?.nextRunAt ?? 0).toBeGreaterThanOrEqual(before + 3_600_000 - 1000)
  })

  test('an invalid status is refused and the run goes on', async () => {
    const seen: Recorded[] = []
    const provider = scripted([end('finished', 'x'), { response: { content: 'carried on' } }], seen)
    const { runner, store } = makeRunner({ provider })
    const run = await runner.runNow(createTask(store).id)
    expect(run?.result).toBe('carried on')
    expect(lastToolResult(seen, 'end_task needs')).toContain('done, blocked or abandoned')
  })
})

describe('where the tools exist', () => {
  test('a bounded task run offers both; extensions=false leaves only end_task', async () => {
    const seen: Recorded[] = []
    const { runner, store } = makeRunner({
      provider: scripted([{ response: { content: 'ok' } }], seen),
    })
    await runner.runNow(createTask(store).id)
    expect(seen[0]?.tools).toContain('request_extension')
    expect(seen[0]?.tools).toContain('end_task')

    const seenOff: Recorded[] = []
    const off = makeRunner({
      provider: scripted([{ response: { content: 'ok' } }], seenOff),
      tasks: { extensions: false },
    })
    await off.runner.runNow(createTask(off.store).id)
    expect(seenOff[0]?.tools).not.toContain('request_extension')
    expect(seenOff[0]?.tools).toContain('end_task')
  })

  test('an unbounded task run gets neither', async () => {
    const seen: Recorded[] = []
    const { runner, store } = makeRunner({
      provider: scripted([{ response: { content: 'ok' } }], seen),
    })
    await runner.runNow(createTask(store, 'scheduled', { unbounded: true }).id)
    expect(seen[0]?.tools).not.toContain('request_extension')
    expect(seen[0]?.tools).not.toContain('end_task')
  })

  test('a plain agent run outside the task runner gets neither', async () => {
    const seen: Recorded[] = []
    const workspace = mkdtempSync(join(tmpdir(), 'egirl-deadlines-chat-'))
    const executor = createToolExecutor()
    executor.register(noopTool)
    const agent = new AgentLoop({
      config: makeConfig(workspace),
      toolExecutor: executor,
      localProvider: scripted([{ response: { content: 'hi' } }], seen),
      sessionId: 'chat:test',
    })
    await agent.run('hello')
    expect(seen[0]?.tools).toEqual(['noop'])
  })

  test('the wrap-up warning names both tools when the run has them', async () => {
    const seen: Recorded[] = []
    const workspace = mkdtempSync(join(tmpdir(), 'egirl-deadlines-wrap-'))
    const executor = createToolExecutor()
    executor.register(noopTool)
    const stub = (name: string): Tool => ({
      definition: { name, description: name, parameters: { type: 'object' } },
      execute: async () => ({ success: true, output: 'ok' }),
    })
    const agent = new AgentLoop({
      config: makeConfig(workspace),
      toolExecutor: executor,
      localProvider: scripted([{ response: { content: 'wrapped' } }], seen),
      sessionId: 'task:wrap',
    })
    await agent.run('go', {
      deadline: () => Date.now() + 60_000,
      wrapupMarginMs: 600_000,
      extraTools: new Map([
        ['request_extension', stub('request_extension')],
        ['end_task', stub('end_task')],
      ]),
    })
    const warned = seen[0]?.messages ?? ''
    expect(warned).toContain('nearly this round')
    expect(warned).toContain('request_extension')
    expect(warned).toContain('end_task')
  })

  test('the wrap-up warning re-arms when an extension moves the deadline out', async () => {
    const seen: Recorded[] = []
    const workspace = mkdtempSync(join(tmpdir(), 'egirl-deadlines-rearm-'))
    const executor = createToolExecutor()
    executor.register(noopTool)
    let deadline = Date.now() + 60_000
    const extend: Tool = {
      definition: { name: 'request_extension', description: 'x', parameters: { type: 'object' } },
      execute: async () => {
        // Granted: the deadline moves far outside the margin.
        deadline = Date.now() + 3_600_000
        return { success: true, output: 'granted' }
      },
    }
    const agent = new AgentLoop({
      config: makeConfig(workspace),
      toolExecutor: executor,
      localProvider: scripted(
        [
          call('request_extension', { minutes: 60 }),
          call('noop', { n: 1 }),
          { response: { content: 'done' } },
        ],
        seen,
      ),
      sessionId: 'task:rearm',
    })
    let calls = 0
    await agent.run('go', {
      maxTurns: 5,
      deadline: () => {
        calls++
        // Turn 3: the extended deadline nears again.
        if (calls === 3) deadline = Date.now() + 60_000
        return deadline
      },
      wrapupMarginMs: 600_000,
      extraTools: new Map([['request_extension', extend]]),
    })
    const count = (i: number) => (seen[i]?.messages ?? '').split('nearly this round').length - 1
    expect(count(0)).toBe(1) // warned at the start
    expect(count(1)).toBe(1) // extended: not warned again
    expect(count(2)).toBe(2) // nearing again: warned a second time
  })
})

describe('empty final answer', () => {
  test('fails a one-shot task instead of retiring it as done', async () => {
    const provider = scripted([call('noop', { n: 1 }), { response: { content: '' } }], [])
    const { runner, store } = makeRunner({ provider })
    const task = createTask(store)

    const run = await runner.runNow(task.id)
    expect(run?.status).toBe('failure')
    expect(run?.error).toContain('without a final answer')
    expect(store.get(task.id)?.status).not.toBe('done')
  })

  test('a recurring task may still end quietly', async () => {
    const provider = scripted([{ response: { content: '' } }], [])
    const { runner, store } = makeRunner({ provider })
    const task = createTask(store, 'scheduled')

    expect((await runner.runNow(task.id))?.status).toBe('success')
  })
})
