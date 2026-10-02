import { afterEach, describe, expect, test } from 'bun:test'
import { sanitizedEnv } from '../../src/util/env'

const SET = {
  OPENAI_API_KEY: 'sk-test',
  EGIRL_TUTOR_API_KEY: 'tutor-key',
  EGIRL_CONFIG: '/tmp/agent.toml',
  EGIRL_LOCAL_ENDPOINT: 'http://127.0.0.1:8080',
  GITHUB_TOKEN: 'ghp_test',
  AWS_SHARED_CREDENTIALS_FILE: '/tmp/creds',
  EGIRL_ENV_TEST_KEEP: undefined,
  PATH_FOR_ENV_TEST: '/usr/bin',
}

afterEach(() => {
  for (const key of Object.keys(SET)) delete process.env[key]
})

describe('sanitizedEnv', () => {
  test("strips API keys, credentials and the agent's own EGIRL_ config from child processes", () => {
    for (const [key, value] of Object.entries(SET))
      if (value !== undefined) process.env[key] = value
    const env = sanitizedEnv()
    for (const key of [
      'OPENAI_API_KEY',
      'EGIRL_TUTOR_API_KEY',
      'EGIRL_CONFIG',
      'EGIRL_LOCAL_ENDPOINT',
      'GITHUB_TOKEN',
      'AWS_SHARED_CREDENTIALS_FILE',
    ]) {
      expect(env[key]).toBeUndefined()
    }
    expect(env.PATH_FOR_ENV_TEST).toBe('/usr/bin')
  })
})
