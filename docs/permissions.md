# Permission Supervisor

egirl has a shared permission supervisor for code-agent prompts. It normalizes backend-specific prompts into one decision flow so policy, local-model judgment, and memory can be configured in one place.

## Decision Flow

1. Normalize the backend prompt into a permission request.
2. Apply configured policy rules in order: `deny`, `ask_user`, then `allow`.
3. If no rule matches and mode is `supervised`, recall relevant memories.
4. Ask the local model for strict JSON:

```json
{"action":"allow|deny|choose|ask_user","optionId":"...","reason":"...","confidence":0.8}
```

5. If configured, escalate low-confidence decisions to `ask_user`.
6. Optionally write a compact decision trace to memory.

## Backend Behavior

### Codex `code_agent`

Codex runs in an interactive PTY. When egirl sees a trust, permission, or clarification prompt with numbered choices, it sends the prompt, options, recent screen context, and original task to the permission supervisor.

- `choose` sends the selected option number back to Codex.
- `deny` chooses a deny/cancel option when one is visible.
- `ask_user` stops the tool and returns an approval-needed message.

### Claude `code_agent`

Claude runs in-process via the Agent SDK. When the supervisor is active (mode is not `bypass`), egirl runs Claude in a gating permission mode and passes a `canUseTool` callback, so the SDK routes each tool call it would otherwise prompt on through the supervisor. This is complementary to Claude's own permissions: Claude decides which calls are worth gating, the supervisor decides each one.

- `allow` / `choose` lets the tool call proceed.
- `deny` returns the supervisor's reason to Claude as the tool result, so it can re-steer and retry — write the reason as guidance, not just a refusal.
- `ask_user` interrupts the run and returns an approval-needed message.

When mode is `bypass`, Claude keeps its prior behavior: it honors the configured `permission_mode` (including `bypassPermissions`) and the supervisor is not consulted.

### Claude Code bridge

The direct `claude-code` / `cc` bridge has its own local-model permission flow. It asks for `ALLOW` or `DENY` and answers Claude questions from task context.

## Config

```toml
[permission_supervisor]
mode = "supervised"          # bypass, supervised, rules_only, ask_user
default_action = "allow"     # allow, deny, ask_user
think_before_deciding = true
min_confidence = 0.65
ask_user_below_confidence = false
memory_recall = true
memory_write = false

[permission_supervisor.policy]
allow = ["git status", "bun test"]
deny = ["rm -rf", ".env"]
ask_user = ["git push", "curl"]
```

Policy rules are simple substring/wildcard matches across prompt text, backend, tool name, working directory, recent context, and tool input.

## Memory

When `memory_recall = true`, egirl searches project and preference memories for relevant policy context. Useful examples:

- "User allows running tests without asking."
- "Never edit production Kubernetes manifests without asking."
- "This repo uses bun, not npm."

When `memory_write = true`, decisions are stored as compact project memories. Keep this off if you do not want operational decision traces in memory.
