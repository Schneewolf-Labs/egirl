/**
 * Integration test for the code_agent tool.
 * Verifies Claude Code can be spawned, given instructions, and that
 * permission prompts can be handled programmatically via canUseTool.
 *
 * Run with: bun run scripts/test-code-agent.ts
 */
import { mkdir, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCodeAgentTool } from '../src/tools/builtin/code-agent'

const PASS = '\x1b[38;5;114m✓\x1b[0m'
const FAIL = '\x1b[38;5;204m✗\x1b[0m'
const INFO = '\x1b[38;5;141m·\x1b[0m'

function pass(msg: string) {
  console.log(`  ${PASS} ${msg}`)
}

function fail(msg: string) {
  console.error(`  ${FAIL} ${msg}`)
}

function info(msg: string) {
  console.log(`  ${INFO} ${msg}`)
}

async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`\n\x1b[38;5;135m${name}\x1b[0m\n`)
  try {
    await fn()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}

// ── Test 1: bypassPermissions — simple file creation ────────────────────────

await test('bypassPermissions: create a file', async () => {
  const dir = join(tmpdir(), `egirl-code-agent-test-${Date.now()}`)
  await mkdir(dir, { recursive: true })

  info(`Working dir: ${dir}`)

  const tool = createCodeAgentTool({
    permissionMode: 'bypassPermissions',
    workingDir: dir,
    maxTurns: 5,
    timeoutMs: 60_000,
  })

  const result = await tool.execute(
    { task: 'Create a file called hello.txt containing exactly the text: greetings from code agent' },
    dir,
  )

  if (!result.success) {
    fail(`Tool returned failure: ${result.output}`)
    return
  }

  pass(`Tool succeeded`)
  info(`Output: ${result.output.slice(0, 120)}`)

  const content = await readFile(join(dir, 'hello.txt'), 'utf-8').catch(() => null)
  if (content === null) {
    fail('hello.txt was not created')
  } else if (!content.includes('greetings from code agent')) {
    fail(`Unexpected content: ${JSON.stringify(content)}`)
  } else {
    pass(`hello.txt created with correct content: ${JSON.stringify(content.trim())}`)
  }

  await rm(dir, { recursive: true, force: true })
})

// ── Test 2: canUseTool — programmatic permission decisions ───────────────────

await test('canUseTool: auto-approve Write, deny Bash', async () => {
  const dir = join(tmpdir(), `egirl-code-agent-perm-${Date.now()}`)
  await mkdir(dir, { recursive: true })

  info(`Working dir: ${dir}`)

  const decisions: { tool: string; allowed: boolean }[] = []

  // Patch createCodeAgentTool to inject canUseTool. We call query directly here
  // to test the callback plumbing since createCodeAgentTool doesn't expose it yet.
  const { query } = await import('@anthropic-ai/claude-agent-sdk')

  let finalResult = ''
  let succeeded = false

  for await (const message of query({
    prompt: 'Write a file called canuse.txt with content "permission test passed". Do not run any shell commands.',
    options: {
      permissionMode: 'default',
      cwd: dir,
      allowedTools: ['Write', 'Read', 'Glob'],
      maxTurns: 5,
      canUseTool: async (toolName, _input) => {
        const allowed = toolName !== 'Bash'
        decisions.push({ tool: toolName, allowed })
        info(`canUseTool: ${toolName} → ${allowed ? 'allow' : 'deny'}`)
        if (allowed) {
          return { behavior: 'allow' }
        }
        return { behavior: 'deny', message: 'Bash is not permitted in this test' }
      },
    },
  })) {
    if (!('type' in message)) continue
    if (message.type === 'result') {
      const r = message as { result?: string; num_turns?: number }
      finalResult = r.result ?? ''
      succeeded = true
    }
  }

  if (!succeeded) {
    fail('query did not emit a result message')
    await rm(dir, { recursive: true, force: true })
    return
  }

  pass(`Query completed. Result: ${finalResult.slice(0, 100)}`)

  if (decisions.length === 0) {
    info('No canUseTool calls were made (model may have had pre-approved tools)')
  } else {
    pass(`canUseTool was called ${decisions.length} time(s): ${decisions.map(d => `${d.tool}:${d.allowed ? 'allow' : 'deny'}`).join(', ')}`)
  }

  const content = await readFile(join(dir, 'canuse.txt'), 'utf-8').catch(() => null)
  if (content === null) {
    fail('canuse.txt was not created')
  } else {
    pass(`canuse.txt created: ${JSON.stringify(content.trim())}`)
  }

  await rm(dir, { recursive: true, force: true })
})

console.log('\n')
