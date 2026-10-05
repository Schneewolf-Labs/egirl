/**
 * Reproduces a late Claude SDK control-response write after a code-agent timeout, in its own
 * process (bun test intercepts unhandled rejections itself, so the real outcome is only visible
 * here). Mode "sdk": the SDK's "Operation aborted" — must be survived. Mode "unrelated": any other
 * error — must still crash the process.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionSupervisor } from '../../src/permissions/supervisor'
import { runClaudeSession } from '../../src/tools/builtin/code-agent/claude'

const mode = process.argv[2] ?? 'sdk'

function lateError(): Error {
  if (mode !== 'sdk') return new Error('unrelated failure')
  const error = new Error('Operation aborted')
  error.stack =
    'Error: Operation aborted\n    at write (/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:19:5590)'
  return error
}

const supervisor = {
  isActive: () => true,
  decide: () =>
    new Promise((resolve) => setTimeout(() => resolve({ action: 'allow', reason: 'ok' }), 150)),
} as unknown as PermissionSupervisor

const fakeQuery = (({ options }: { options: Options }) =>
  (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's' } as unknown as SDKMessage
    // Like the SDK: an un-awaited control-request handler asks permission, then writes the answer.
    void (async () => {
      await options.canUseTool?.('Bash', { command: 'pytest' }, {
        signal: new AbortController().signal,
        toolUseID: 't1',
      } as unknown as Parameters<NonNullable<Options['canUseTool']>>[2])
      if (options.abortController?.signal.aborted) throw lateError()
    })()
    await new Promise<void>((resolve) => {
      options.abortController?.signal.addEventListener('abort', () => resolve())
    })
    throw new Error('Claude Code process aborted by user')
  })()) as unknown as Parameters<typeof runClaudeSession>[5]

// No top-level await: Bun does not treat a rejection as fatal while the entry module is pending.
async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'egirl-late-abort-'))
  const result = await runClaudeSession(
    { permissionMode: 'default', workingDir: dir, timeoutMs: 50, permissionSupervisor: supervisor },
    'task',
    dir,
    [],
    {},
    fakeQuery,
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  console.log(`survived: ${result.output.split('\n')[0]}`)
  process.exit(0)
}
void main()
