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
