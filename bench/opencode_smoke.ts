/**
 * Does the OpenCode backend actually do work?
 *
 * Calls the backend directly rather than through the agent loop, so a failure is attributable to
 * the integration and not to whatever the local operator model decided to do. Verification is by
 * outcome: a sandbox repo ships with a failing test, the agent is asked to fix it, and the repo's
 * own test suite decides whether it did. No judging, no string matching on the response.
 *
 * The sandbox is a throwaway git repo under /tmp. Pointing an agent at a live checkout is how the
 * operator bench once got egirl.example.toml rewritten and 117 lines deleted.
 *
 * Usage:
 *   bun run bench/opencode_smoke.ts <sandbox-dir> [model]
 */
import { createCodeAgentTool } from '../src/tools/builtin/code-agent'
import type { CodeAgentConfig } from '../src/tools/builtin/code-agent/types'

const dir = process.argv[2]
const model = process.argv[3] ?? 'opencode/glm-4.7-free'
if (!dir) {
  console.error('usage: bun run bench/opencode_smoke.ts <sandbox-dir> [model]')
  process.exit(2)
}

const config: CodeAgentConfig = {
  provider: 'opencode',
  permissionMode: 'bypassPermissions',
  model,
  workingDir: dir,
  timeoutMs: 600_000,
}

const task =
  'The function `mean` in mathutil.py raises NotImplementedError. Implement it so that it ' +
  'returns the arithmetic mean of a list of numbers. Do not change the tests.'

console.log(`model:   ${model}`)
console.log(`workdir: ${dir}`)
const started = Date.now()
const tool = createCodeAgentTool(config)
const result = await tool.execute({ task, working_dir: dir }, dir)
const elapsed = ((Date.now() - started) / 1000).toFixed(1)

console.log(`\nelapsed: ${elapsed}s`)
console.log(`success: ${result.success}`)
console.log(`output (first 800):\n${(result.output ?? '(no output)').slice(0, 800)}`)
