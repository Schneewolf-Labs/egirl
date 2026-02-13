# Routing and Escalation

egirl routes every request to either the local model (llama.cpp) or a remote provider (Anthropic/OpenAI). This document explains how routing decisions are made and when escalation occurs.

## How Routing Works

When a user sends a message, the Router makes a decision in three stages:

```
User Message
     │
     ▼
┌──────────────────┐
│  1. Heuristics   │  ← Keyword analysis of message content
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  2. Rules        │  ← Priority-based rules from egirl.toml
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  3. Combine      │  ← Merge heuristic + rule results
└────────┬─────────┘
         │
         ▼
   RoutingDecision
   { target, reason, confidence }
```

### Stage 1: Heuristics

`analyzeMessageHeuristics()` in `src/routing/heuristics.ts` scans the user's message for signal words:

**Routes to local (stays local):**
- Short greetings: "hi", "hello", "hey", "thanks"
- Tool use patterns: "read file", "run command", "search for"
- Messages with 3 or fewer words that match simple keywords

**Routes to remote (suggests escalation):**
- Code keywords: "write code", "implement", "refactor", "debug", "code review", "write tests"
- Complex reasoning: "explain in detail", "analyze", "compare and contrast", "step by step"
- Code blocks (``` in the message)
- Long messages (100+ words)

Each heuristic returns a confidence score (0.0–1.0). Higher confidence means more certain about the routing decision.

### Stage 2: Rules

`applyRules()` in `src/routing/rules.ts` checks the message against configurable rule lists from `egirl.toml`:

```toml
[routing]
always_local = ["memory_search", "memory_get", "greeting", "acknowledgment"]
always_remote = ["code_generation", "code_review", "complex_reasoning"]
```

Rules are matched against the detected task type. The Router detects task types using keyword patterns:

| Task Type | Detection Keywords |
|-----------|-------------------|
| `memory_op` | "remember", "recall", "what did I" |
| `code_generation` | "write code", "implement", "create a function", code blocks |
| `tool_use` | "read file", "execute", "run command", "search for" |
| `reasoning` | "explain", "analyze", "why", "how does" |
| `conversation` | (default — no specific keywords matched) |

Rules also consider complexity:
- **trivial** (≤5 words, no code) → local
- **simple** (≤20 words, no code) → local
- **moderate** (≤100 words, or has code) → depends on task type
- **complex** (100+ words) → remote

### Stage 3: Combination

The final decision merges heuristic and rule results:

1. Start with the rule-based decision
2. If heuristics strongly suggest escalation (confidence > 0.7), override with remote
3. If remote is chosen but no remote provider is configured, fall back to local with a warning

## Escalation

Escalation is the process of switching from the local model to a remote model **mid-conversation**. It happens after the local model has already responded.

### Post-Response Escalation

`analyzeResponseForEscalation()` in `src/routing/escalation.ts` checks local model responses for signs of struggle:

**Uncertainty patterns** (triggers escalation):
- "I'm not sure", "I don't know", "I cannot"
- "This is beyond", "I would need more"
- "I'm having trouble", "This is complex"

**Error patterns** (triggers if code block present):
- "error:", "failed to", "cannot parse"
- "invalid", "syntax error"

**Insufficient response**:
- Response shorter than 50 characters with no tool calls

The escalation threshold is configurable:

```toml
[routing]
escalation_threshold = 0.4
```

If the local model's confidence score falls below this threshold, the agent switches to the remote provider and retries the same turn.

### Tool-Suggested Escalation

Any tool can include `suggest_escalation: true` in its result. This happens when:

- `edit_file` can't find the target text (may need better context understanding)
- A tool encounters an error that suggests the model chose the wrong approach

When a tool suggests escalation, the agent switches providers for the next turn of the loop.

## Escalation Flow

```
Local Model Response
        │
        ▼
┌───────────────────┐
│ Check confidence  │
│ < threshold?      │──── Yes ──→ Switch to remote, retry
└───────┬───────────┘
        │ No
        ▼
┌───────────────────┐
│ Check uncertainty │
│ patterns?         │──── Yes ──→ Switch to remote, retry
└───────┬───────────┘
        │ No
        ▼
┌───────────────────┐
│ Check tool results│
│ suggest_escalation│──── Yes ──→ Switch to remote, next turn
└───────┬───────────┘
        │ No
        ▼
   Continue with local

```

## Fallback Behavior

If no remote provider is configured (no API keys in `.env`):

- All routing decisions fall back to `local`
- Escalation is disabled — the local model handles everything
- A warning is logged: "Remote provider not available, falling back to local"

## RoutingDecision

Every routing decision is represented as:

```typescript
interface RoutingDecision {
  target: 'local' | 'remote'  // Where to send the request
  provider?: string            // e.g., "llamacpp/qwen3-vl-32b" or "anthropic/claude-sonnet-4"
  reason: string               // Why this decision was made
  confidence: number           // 0.0–1.0
}
```

Reasons include: `simple_greeting`, `code_generation`, `complex_reasoning`, `tool_use`, `heuristic_escalation`, `no_remote_provider`, `long_context`, `code_discussion`.

## Tuning the Router

**Make the local model handle more:**
- Increase `escalation_threshold` (e.g., 0.2 — only escalate if very low confidence)
- Add task types to `always_local`
- Use a larger local model

**Escalate more aggressively:**
- Decrease `escalation_threshold` (e.g., 0.6 — escalate on moderate uncertainty)
- Add task types to `always_remote`
- Keep the `always_local` list minimal

**Local-only operation:**
- Don't set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env`
- All requests route to local regardless of rules
