/**
 * Build a copy of process.env with secret-shaped variables stripped.
 * Used when handing the environment to child processes the agent spawns.
 */
const SECRET_PATTERNS = [
  /^ANTHROPIC_/i,
  /^DISCORD_TOKEN$/i,
  /^GITHUB_TOKEN$/i,
  /^AWS_SECRET/i,
  /^SSH_/i,
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /PRIVATE.?KEY/i,
  // OPENAI_API_KEY, EGIRL_TUTOR_API_KEY and friends matched none of the above, so every command
  // the agent ran inherited them, and one `env` printed them into the transcript.
  /API.?KEY/i,
  /CREDENTIAL/i,
  // The agent's own configuration is not the child's. A command that runs egirl itself (its test
  // suite, a second instance) otherwise loads this process's config file and endpoints.
  /^EGIRL_/,
]

export function sanitizedEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_PATTERNS.some((p) => p.test(key))) {
      env[key] = value
    }
  }
  return env
}
