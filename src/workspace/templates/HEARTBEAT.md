# Heartbeat Checks

Items for the agent to check on a schedule. Unchecked items are processed
each heartbeat cycle. Check them off when no longer needed, or let the agent
update this file with results.

## How it works

- The agent reads this file on each heartbeat tick
- Only unchecked (`- [ ]`) items trigger a run — no items means no LLM cost
- Results are reported to your active channel (Discord DM, CLI, etc.)
- You can edit this file anytime — add, remove, or check off items
- The agent can also update this file to track state across runs

## Checks

- [ ] Check CI status on the main branch
- [ ] Review open PRs older than 2 days
- [ ] Summarize recent git activity if idle for 4+ hours
