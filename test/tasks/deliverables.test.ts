/**
 * Task deliverables: files a task declares it must leave behind, checked on disk after the run.
 *
 * The failure this pins: a long one-shot review run ended with "review written to <path>" and
 * no file at that path. The reply is a claim; the runner checks the disk, gives the agent one
 * corrective turn when something is missing, and marks the result if it is still missing.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatResponse, LLMProvider } from '../../src/providers/types'
import { checkDeliverables } from '../../src/tasks/deliverables'
import { createTaskRunner } from '../../src/tasks/runner'
import { createTaskStore } from '../../src/tasks/store'
import { createToolExecutor } from '../../src/tools/executor'
import type { Tool } from '../../src/tools/types'
import { makeConfig, stubResponse } from '../agent/helpers'

describe('checkDeliverables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egirl-deliv-'))

  test('a fresh non-empty file passes; relative paths resolve against the workspace', () => {
    writeFileSync(join(dir, 'review.md'), '# review\n')
    expect(
      checkDeliverables(['review.md', join(dir, 'review.md')], dir, Date.now() - 1000),
    ).toEqual([])
  })

  test('missing, empty and stale files are each reported', () => {
    writeFileSync(join(dir, 'empty.md'), '')
    writeFileSync(join(dir, 'old.md'), 'from an earlier run\n')
    const hourAgo = (Date.now() - 3600_000) / 1000
    utimesSync(join(dir, 'old.md'), hourAgo, hourAgo)

    const issues = checkDeliverables(['nope.md', 'empty.md', 'old.md'], dir, Date.now() - 1000)
    expect(issues.map((i) => [i.path, i.problem])).toEqual([
      ['nope.md', 'missing'],
      ['empty.md', 'empty'],
      ['old.md', 'stale'],
    ])
    expect(issues[0]?.resolved).toBe(join(dir, 'nope.md'))
  })

  test('a directory counts when it was written to during the run', () => {
    mkdirSync(join(dir, 'out'))
    expect(checkDeliverables(['out'], dir, Date.now() - 1000)).toEqual([])
  })
})

/** A write tool the stub model can call, so a run (or its corrective turn) really writes. */
function writeTool(workspace: string): Tool {
  return {
    definition: {
      name: 'write_file',
      description: 'stub write',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    async execute(args) {
      writeFileSync(join(workspace, String(args.path)), String(args.content))
      return { success: true, output: `wrote ${args.path}` }
    },
  }
}

const writeCall = (path: string): Partial<ChatResponse> => ({
  tool_calls: [{ id: `w-${path}`, name: 'write_file', arguments: { path, content: 'findings\n' } }],
  finish_reason: 'tool_calls',
})

function makeRunner(responses: Array<Partial<ChatResponse>>) {
  const workspace = mkdtempSync(join(tmpdir(), 'egirl-deliv-run-'))
  const config = makeConfig(workspace)
  const store = createTaskStore(join(workspace, 'tasks.db'))
  const executor = createToolExecutor()
  executor.register(writeTool(workspace))
  const prompts: string[] = []
  let n = 0
  const provider: LLMProvider = {
    name: 'stub',
    async chat(req): Promise<ChatResponse> {
      const last = req.messages[req.messages.length - 1]
      if (last?.role === 'user') prompts.push(String(last.content))
      const next = responses[Math.min(n, responses.length - 1)]
      n++
      return stubResponse(next ?? { content: 'done' })
    },
  }
  const runner = createTaskRunner({
    config,
    tasksConfig: config.tasks,
    store,
    toolExecutor: executor,
    localProvider: provider,
    memory: undefined,
    outbound: new Map(),
  })
  const create = (deliverables?: string[]) =>
    store.create({
      name: 'review',
      description: 'review the PRs',
      kind: 'oneshot',
      prompt: 'review and write review.md',
      ...(deliverables && { deliverables }),
      channel: 'api',
      channelTarget: 'api:default',
      createdBy: 'user',
    })
  return { runner, store, create, prompts }
}

describe('runner deliverable check', () => {
  test('a run that wrote its deliverable is booked as-is, no corrective turn', async () => {
    const { runner, create, prompts } = makeRunner([
      writeCall('review.md'),
      { content: 'Review written to review.md.' },
    ])
    const run = await runner.runNow(create(['review.md']).id)
    expect(run?.status).toBe('success')
    expect(run?.result).toBe('Review written to review.md.')
    expect(prompts.some((p) => p.includes('Deliverable check'))).toBe(false)
  })

  test('a missing deliverable gets one corrective turn; written then, the result says so', async () => {
    const { runner, create, prompts } = makeRunner([
      { content: 'Review written to review.md.' }, // the claim, no write
      writeCall('review.md'),
      { content: 'Written now: ls shows review.md.' },
    ])
    const run = await runner.runNow(create(['review.md']).id)
    expect(run?.status).toBe('success')
    expect(prompts.filter((p) => p.includes('Deliverable check'))).toHaveLength(1)
    expect(prompts.find((p) => p.includes('Deliverable check'))).toContain('review.md')
    expect(run?.result).toStartWith('Review written to review.md.')
    expect(run?.result).toContain('missing after the run; written on a corrective turn')
    expect(run?.result).toContain('Written now: ls shows review.md.')
  })

  test('still missing after the corrective turn: the result is marked at the top', async () => {
    const { runner, create } = makeRunner([
      { content: 'Review written to review.md.' },
      { content: 'It is written, I checked.' },
    ])
    const run = await runner.runNow(create(['review.md']).id)
    expect(run?.status).toBe('success')
    expect(run?.result).toStartWith('[Deliverable check FAILED')
    expect(run?.result).toContain('review.md')
    expect(run?.result).toContain('does not exist')
    expect(run?.result).toContain('It is written, I checked.')
  })

  test('a task without deliverables is untouched', async () => {
    const { runner, create, prompts } = makeRunner([{ content: 'Review written to review.md.' }])
    const run = await runner.runNow(create().id)
    expect(run?.result).toBe('Review written to review.md.')
    expect(prompts.some((p) => p.includes('Deliverable check'))).toBe(false)
  })
})

describe('task store deliverables', () => {
  test('stored, updated and cleared', () => {
    const { store, create } = makeRunner([])
    const task = create(['~/work/reviews/a.md', 'b.md'])
    expect(store.get(task.id)?.deliverables).toEqual(['~/work/reviews/a.md', 'b.md'])
    store.update(task.id, { deliverables: ['c.md'] })
    expect(store.get(task.id)?.deliverables).toEqual(['c.md'])
    store.update(task.id, { deliverables: undefined })
    expect(store.get(task.id)?.deliverables).toBeUndefined()
    expect(store.get(create().id)?.deliverables).toBeUndefined()
  })
})
