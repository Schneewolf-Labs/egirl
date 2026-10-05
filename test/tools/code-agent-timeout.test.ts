import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionSupervisor } from '../../src/permissions/supervisor'
import {
  buildCanUseTool,
  isLateSdkAbort,
  runClaudeSession,
} from '../../src/tools/builtin/code-agent/claude'
import { runCodexSession } from '../../src/tools/builtin/code-agent/codex'
import type { CodexConnection, RpcObject } from '../../src/tools/builtin/code-agent/codex-rpc'
import { shouldFailover } from '../../src/tools/builtin/code-agent/failover'
import {
  ActionLog,
  formatTimeoutReport,
  gitSummary,
  parseResumeSession,
  TIMEOUT_PREFIX,
} from '../../src/tools/builtin/code-agent/timeout-report'

/**
 * Observed: a 30-minute delegation (merge main into a PR branch, build a venv, run two suites)
 * returned only "Code agent timed out after 1800s", failover then tried a provider that was not
 * configured, and the operator could not tell what had been done or continue it.
 */

function git(dir: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'egirl-timeout-git-'))
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git(dir, 'add', 'a.txt')
  git(dir, 'commit', '-q', '-m', 'init')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(dir, 'new.txt'), 'x\n')
  return dir
}

const plainDir = (): string => mkdtempSync(join(tmpdir(), 'egirl-timeout-plain-'))

type FakeQuery = Parameters<typeof runClaudeSession>[5]

/** A Claude SDK stream: init, `n` tool calls with a running commentary, then hang until abort. */
function hangingQuery(n: number, seen: { options?: Options; prompt?: unknown }): FakeQuery {
  return (({ prompt, options }: { prompt: unknown; options: Options }) => {
    seen.options = options
    seen.prompt = prompt
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-123' } as unknown as SDKMessage
      for (let i = 1; i <= n; i++) {
        yield {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: `Step ${i}: resolving merge conflicts.` },
              { type: 'tool_use', name: 'Bash', input: { command: `pytest tests/part${i}` } },
            ],
          },
        } as unknown as SDKMessage
      }
      await new Promise<void>((resolve) => {
        options.abortController?.signal.addEventListener('abort', () => resolve())
      })
      throw new Error('Claude Code process aborted by user')
    })()
  }) as unknown as FakeQuery
}

describe('failover on timeout', () => {
  test('a timeout report does not fail over — the agent ran and left partial work', () => {
    expect(
      shouldFailover({ success: false, output: `${TIMEOUT_PREFIX} 1800s (claude, 0 tool calls)` }),
    ).toBe(false)
  })

  test('a backend server that never started still fails over', () => {
    expect(
      shouldFailover({
        success: false,
        output: 'Code agent error: opencode server did not start within 300000ms',
      }),
    ).toBe(true)
  })
})

describe('claude timeout report', () => {
  test('reports turns, recent actions, last message, git state, and the session to resume', async () => {
    const dir = gitRepo()
    const seen: { options?: Options } = {}
    const result = await runClaudeSession(
      { permissionMode: 'bypassPermissions', workingDir: dir, timeoutMs: 100 },
      'merge main and run the tests',
      dir,
      [],
      {},
      hangingQuery(12, seen),
    )
    expect(result.success).toBe(false)
    expect(shouldFailover(result)).toBe(false)
    const out = result.output
    expect(out.startsWith(`${TIMEOUT_PREFIX} 0s`)).toBe(true)
    expect(out).toContain('12 turns')
    expect(out).toContain('Last 10 of 12 actions:')
    expect(out).toContain('- Bash: pytest tests/part12')
    expect(out).toContain('- Bash: pytest tests/part3')
    expect(out).not.toContain('tests/part2\n')
    expect(out).toContain('Step 12: resolving merge conflicts.')
    expect(out).toContain('git status --short:')
    expect(out).toContain(' M a.txt')
    expect(out).toContain('?? new.txt')
    expect(out).toContain('git diff --stat:')
    expect(out).toContain('resume_session="claude:sess-123"')
    expect(out).not.toContain('aborted by user')
  })

  test('a non-git working dir still gets a report, without the git section', async () => {
    const dir = plainDir()
    const result = await runClaudeSession(
      { permissionMode: 'bypassPermissions', workingDir: dir, timeoutMs: 50 },
      'task',
      dir,
      [],
      {},
      hangingQuery(1, {}),
    )
    expect(result.output.startsWith(TIMEOUT_PREFIX)).toBe(true)
    expect(result.output).toContain('- Bash: pytest tests/part1')
    expect(result.output).not.toContain('git status')
  })

  test('resume_session is passed to the SDK as `resume`, with the task as the next prompt', async () => {
    const seen: { options?: Options; prompt?: unknown } = {}
    const fake = (({ prompt, options }: { prompt: unknown; options: Options }) => {
      seen.options = options
      seen.prompt = prompt
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess-123' } as unknown as SDKMessage
        yield { type: 'result', result: 'Tests pass.', num_turns: 3 } as unknown as SDKMessage
      })()
    }) as unknown as FakeQuery
    const dir = plainDir()
    const result = await runClaudeSession(
      { permissionMode: 'default', workingDir: dir, timeoutMs: 5000 },
      'continue: run only the unit tests',
      dir,
      [],
      { resumeSession: 'sess-123' },
      fake,
    )
    expect(seen.options?.resume).toBe('sess-123')
    expect(seen.prompt).toBe('continue: run only the unit tests')
    expect(result.success).toBe(true)
    expect(result.output).toContain('session: sess-123')
  })

  test('without resume_session no resume option is set', async () => {
    const seen: { options?: Options } = {}
    const dir = plainDir()
    await runClaudeSession(
      { permissionMode: 'default', workingDir: dir, timeoutMs: 50 },
      'task',
      dir,
      [],
      {},
      hangingQuery(0, seen),
    )
    expect(seen.options?.resume).toBeUndefined()
  })
})

describe('codex timeout and resume', () => {
  function connection(
    calls: { method: string; params: RpcObject }[],
    onTurn: (emit: (method: string, params: RpcObject) => void) => void,
  ) {
    return (_cwd: string, events: Parameters<Parameters<typeof runCodexSession>[4]>[1]) =>
      ({
        async request(method: string, params: RpcObject) {
          calls.push({ method, params })
          if (method === 'thread/start' || method === 'thread/resume')
            return { thread: { id: 'thread-9' } }
          if (method === 'turn/start') {
            events.notification('turn/started', { threadId: 'thread-9', turn: { id: 't' } })
            queueMicrotask(() => onTurn(events.notification))
            return { turn: { id: 't' } }
          }
          return {}
        },
        notify() {},
        respond() {},
        reject() {},
        async close() {},
      }) satisfies CodexConnection
  }

  test('a timeout reports commands, file edits, the last message, and the thread', async () => {
    const calls: { method: string; params: RpcObject }[] = []
    const result = await runCodexSession(
      { permissionMode: 'default', workingDir: '/nonexistent-project', timeoutMs: 100 },
      'merge main',
      '/nonexistent-project',
      [],
      connection(calls, (emit) => {
        const base = { threadId: 'thread-9', turnId: 't' }
        emit('item/started', { ...base, item: { type: 'commandExecution', command: 'git merge' } })
        emit('item/started', {
          ...base,
          item: { type: 'fileChange', changes: [{ path: 'src/a.py' }, { path: 'src/b.py' }] },
        })
        emit('item/completed', {
          ...base,
          item: {
            type: 'agentMessage',
            text: 'Conflicts resolved; building venv.',
            phase: 'commentary',
          },
        })
      }),
    )
    expect(result.success).toBe(false)
    expect(result.output.startsWith(TIMEOUT_PREFIX)).toBe(true)
    expect(result.output).toContain('- command: git merge')
    expect(result.output).toContain('- edit: src/a.py, src/b.py')
    expect(result.output).toContain('Conflicts resolved; building venv.')
    expect(result.output).toContain('resume_session="codex:thread-9"')
    expect(calls.find((c) => c.method === 'thread/start')?.params.ephemeral).toBe(false)
  })

  test('resume_session resumes the thread instead of starting one', async () => {
    const calls: { method: string; params: RpcObject }[] = []
    const result = await runCodexSession(
      { permissionMode: 'default', workingDir: '/p', timeoutMs: 2000 },
      'continue: run the tests',
      '/p',
      [],
      connection(calls, (emit) => {
        const base = { threadId: 'thread-9', turnId: 't' }
        emit('item/completed', {
          ...base,
          item: { type: 'agentMessage', text: 'Tests pass.', phase: 'final_answer' },
        })
        emit('turn/completed', { threadId: 'thread-9', turn: { id: 't', status: 'completed' } })
      }),
      { resumeSession: 'thread-9' },
    )
    expect(result.success).toBe(true)
    expect(calls.map((c) => c.method)).not.toContain('thread/start')
    expect(calls.find((c) => c.method === 'thread/resume')?.params.threadId).toBe('thread-9')
  })
})

describe('report helpers', () => {
  test('git summary is undefined outside a git repo', async () => {
    expect(await gitSummary(plainDir())).toBeUndefined()
  })

  test('git summary is bounded', async () => {
    const dir = gitRepo()
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `f${i}.txt`), 'x\n')
    const summary = (await gitSummary(dir)) ?? ''
    const status = summary.split('\n\n')[0] ?? ''
    expect(status.split('\n').length).toBeLessThanOrEqual(22)
    expect(status).toMatch(/\+\d+ more lines/)
  })

  test('a long final message keeps its tail', async () => {
    const actions = new ActionLog()
    const out = await formatTimeoutReport({
      provider: 'claude',
      timeoutMs: 1_800_000,
      workingDir: plainDir(),
      actions,
      lastMessage: `${'filler '.repeat(1000)}NOW RUNNING THE SECOND SUITE`,
    })
    expect(out.startsWith(`${TIMEOUT_PREFIX} 1800s`)).toBe(true)
    expect(out).toContain('NOW RUNNING THE SECOND SUITE')
    expect(out.length).toBeLessThan(1600)
    expect(out).toContain('cannot be resumed')
  })

  test('resume_session parses provider:id and accepts a bare id', () => {
    const providers = ['claude', 'codex', 'opencode']
    expect(parseResumeSession('codex:abc', providers)).toEqual({ provider: 'codex', id: 'abc' })
    expect(parseResumeSession(' 1b2c-3d ', providers)).toEqual({ id: '1b2c-3d' })
    expect(parseResumeSession('weird:abc', providers)).toEqual({ id: 'weird:abc' })
  })
})

describe('permission decision racing the timeout', () => {
  // Observed (claude-agent-sdk 0.2.39): the run timed out while the supervisor was still deciding
  // a permission; the late answer was written to the aborted process, the SDK threw
  // "Operation aborted" from an un-awaited promise, and the unhandled rejection killed egirl.
  const slowSupervisor = (ms: number) =>
    ({
      isActive: () => true,
      decide: () =>
        new Promise((resolve) => setTimeout(() => resolve({ action: 'allow', reason: 'ok' }), ms)),
    }) as unknown as PermissionSupervisor

  const sdkAbortError = (): Error => {
    const error = new Error('Operation aborted')
    error.stack = `Error: Operation aborted\n    at write (/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:19:5590)`
    return error
  }

  test('canUseTool answers immediately once the run is aborted', async () => {
    const run = new AbortController()
    const gate = buildCanUseTool(slowSupervisor(2000), 'task', '/w', () => {}, run.signal)
    const started = Date.now()
    setTimeout(() => run.abort(), 20)
    const result = await gate('Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
      toolUseID: 'x',
    } as unknown as Parameters<typeof gate>[2])
    expect(result).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  const fixture = join(import.meta.dir, '..', 'fixtures', 'late-sdk-abort.ts')

  test('a late SDK write after the timeout does not crash the process', () => {
    // Its own process: bun test intercepts unhandled rejections before process listeners do.
    const run = spawnSync(process.execPath, [fixture, 'sdk'], { encoding: 'utf8', timeout: 20000 })
    expect(run.stdout).toContain(`survived: ${TIMEOUT_PREFIX}`)
    expect(run.status).toBe(0)
  })

  test('an unrelated unhandled rejection is not swallowed', () => {
    const run = spawnSync(process.execPath, [fixture, 'unrelated'], {
      encoding: 'utf8',
      timeout: 20000,
    })
    expect(run.stdout).not.toContain('survived')
    expect(run.status).not.toBe(0)
  })

  test('the safety net matches only the SDK abort', () => {
    expect(isLateSdkAbort(sdkAbortError())).toBe(true)
    expect(isLateSdkAbort(new Error('Operation aborted'))).toBe(false)
    expect(isLateSdkAbort(new Error('something else'))).toBe(false)
  })
})
