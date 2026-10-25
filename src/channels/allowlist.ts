/**
 * Access policy shared by every chat channel's user / JID allow-list.
 *
 * The allow-list is the gate that decides who may drive the agent — and the
 * agent holds shell (`execute_command`), `code_agent`, and file-write tools, so
 * an un-listed sender reaching the turn loop is a remote-code-execution path.
 * The policy is therefore FAIL-CLOSED:
 *
 *   - empty list        -> deny everyone (operator must opt in explicitly)
 *   - list contains "*" -> allow everyone (explicit opt-in to an open bot)
 *   - otherwise         -> allow only senders the channel's matcher accepts
 *
 * An empty list used to mean "allow all"; that silently exposed the agent to
 * anyone who could find the bot. Opening a bot up is now a deliberate `"*"`.
 *
 * `matches` is supplied per channel because identity shape differs (Discord
 * user id, Telegram id/@username, Matrix MXID, XMPP bare JID).
 */
export const ALLOW_ALL = '*'

export function isAllowedByList(
  allowList: readonly string[],
  matches: (entry: string) => boolean,
): boolean {
  if (allowList.length === 0) return false
  if (allowList.includes(ALLOW_ALL)) return true
  return allowList.some(matches)
}

/** One-line summary of what an allow-list admits, for channel startup logs. */
export function describeAllowList(allowList: readonly string[]): string {
  if (allowList.length === 0) return 'no one (empty allow-list — set the allow-list or add "*")'
  if (allowList.includes(ALLOW_ALL)) return 'everyone ("*" present)'
  return allowList.join(', ')
}
