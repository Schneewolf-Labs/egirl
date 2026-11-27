/**
 * safety-filter-false-positives: the command filter must let ordinary work through and still
 * stop the genuinely destructive.
 *
 * No instance: each case goes through checkToolCall('execute_command', ...) with the stock
 * safety config, the same path an execute_command call takes before it runs. The hard-blocked
 * patterns live in src/safety/command-filter.ts and apply whatever the instance's config says,
 * so the stock config is the floor every instance shares. An instance's own blocked_patterns,
 * allow mode or permission rules can only block more.
 *
 * The fork bomb case stays in because the filter does target it (HARD_BLOCKED_PATTERNS).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkToolCall, getDefaultSafetyConfig } from '../../src/safety'
import { type CheckResult, fail, type PureScenario, pass } from './types'

interface FilterCase {
  id: string
  command: string
  expect: 'allow' | 'block'
}

const CASES_PATH = join(import.meta.dir, 'safety-filter-cases.json')

function loadCases(): FilterCase[] {
  const data = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as { cases: FilterCase[] }
  for (const c of data.cases) {
    if (c.expect !== 'allow' && c.expect !== 'block') {
      throw new Error(`${CASES_PATH}: case ${c.id} has expect=${c.expect}`)
    }
  }
  return data.cases
}

function judge(c: FilterCase): CheckResult {
  const verdict = checkToolCall(
    'execute_command',
    { command: c.command },
    '/tmp',
    getDefaultSafetyConfig(),
  )
  const got = verdict.allowed ? 'allow' : 'block'
  const why = verdict.allowed ? 'allowed' : verdict.reason
  const evidence = `${got} (expected ${c.expect}): ${c.command}  →  ${why}`
  return got === c.expect ? pass(c.id, evidence) : fail(c.id, evidence)
}

export const safetyFilterFalsePositives: PureScenario = {
  kind: 'pure',
  name: 'safety-filter-false-positives',
  description: 'ordinary commands pass the command filter; destructive ones are blocked',
  checks: () => loadCases().map(judge),
}
