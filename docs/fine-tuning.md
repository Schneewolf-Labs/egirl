# Fine-Tuning Dataset Strategy

This document outlines how to create training data for fine-tuning models to work as egirl agents.

## Models to Train

| Model | Purpose | Size | Data Volume |
|-------|---------|------|-------------|
| **Router** | Classify: local/remote/escalate | Tiny (1-3B) or LoRA | 2-5k examples |
| **Tool Agent** | Tool calling + task execution | Main model (32B) | 10-20k examples |
| **Personality** | Voice, style, memory integration | LoRA on main model | 5-10k examples |

You can merge Tool Agent and Personality into one fine-tune, but separating them lets you iterate on personality without retraining tool behavior.

## Dataset Categories

### 1. Routing Classification

Simple input → label pairs for the router model:

```jsonl
{"input": "hey", "label": "local", "reason": "greeting"}
{"input": "what time is it", "label": "local", "reason": "simple_query"}
{"input": "refactor this function to use async/await", "label": "remote", "reason": "code_modification"}
{"input": "explain the tradeoffs between Redis and Memcached", "label": "remote", "reason": "complex_analysis"}
{"input": "read ~/.bashrc", "label": "local", "reason": "file_operation"}
{"input": "write a Python script that...", "label": "remote", "reason": "code_generation"}
{"input": "use claude for this", "label": "escalate", "reason": "user_request"}
```

**Generation strategy:**
- Start with heuristic rules from `src/routing/heuristics.ts`
- Have Claude generate 50-100 variations per category
- Add edge cases manually (things that look complex but aren't, and vice versa)

### 2. Tool Calling Behaviors

This needs the most variety. Target these proportions:

| Pattern | % | Description |
|---------|---|-------------|
| Direct answer | 40% | No tool needed |
| Single tool call | 25% | One tool, one response |
| Tool chain | 15% | Multiple sequential tools |
| Clarification | 10% | Ask before acting |
| Error recovery | 10% | Handle tool failures gracefully |

#### A. Direct Answer (No Tool)

```jsonl
{"messages": [
  {"role": "system", "content": "..."},
  {"role": "user", "content": "what's 2 + 2?"},
  {"role": "assistant", "content": "4"}
], "tools": [...]}
```

The model must learn when NOT to use tools.

#### B. Single Tool Call

```jsonl
{"messages": [
  {"role": "system", "content": "..."},
  {"role": "user", "content": "what's in my .env file?"},
  {"role": "assistant", "content": "<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \".env\"}}\n</tool_call>"},
  {"role": "user", "content": "<tool_response>\nDISCORD_TOKEN=xxx\nANTHROPIC_API_KEY=sk-ant-xxx\n</tool_response>"},
  {"role": "assistant", "content": "Your .env contains two secrets:\n- DISCORD_TOKEN\n- ANTHROPIC_API_KEY\n\nI've redacted the values for security."}
], "tools": [...]}
```

#### C. Tool Chain

```jsonl
{"messages": [
  {"role": "user", "content": "find all typescript files with TODO comments"},
  {"role": "assistant", "content": "<tool_call>\n{\"name\": \"glob\", \"arguments\": {\"pattern\": \"**/*.ts\"}}\n</tool_call>"},
  {"role": "user", "content": "<tool_response>\n[\"src/index.ts\", \"src/config.ts\", ...]\n</tool_response>"},
  {"role": "assistant", "content": "<tool_call>\n{\"name\": \"exec\", \"arguments\": {\"command\": \"grep -l 'TODO' src/*.ts\"}}\n</tool_call>"},
  {"role": "user", "content": "<tool_response>\nsrc/config.ts\nsrc/agent/loop.ts\n</tool_response>"},
  {"role": "assistant", "content": "Found TODO comments in 2 files:\n- src/config.ts\n- src/agent/loop.ts"}
], "tools": [...]}
```

#### D. Clarification Before Action

```jsonl
{"messages": [
  {"role": "user", "content": "delete the logs"},
  {"role": "assistant", "content": "Which logs do you want me to delete?\n\n1. Application logs (`~/.egirl/logs/`)\n2. Memory logs (`workspace/memory/`)\n3. Something else?\n\nI want to make sure I don't delete anything important."}
], "tools": [...]}
```

Critical for destructive operations.

#### E. Tool Failure Recovery

```jsonl
{"messages": [
  {"role": "user", "content": "read /etc/shadow"},
  {"role": "assistant", "content": "<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"/etc/shadow\"}}\n</tool_call>"},
  {"role": "user", "content": "<tool_response>\nError: Permission denied\n</tool_response>"},
  {"role": "assistant", "content": "I can't read /etc/shadow — it requires root privileges and contains password hashes. Is there something specific you're trying to check? I might be able to help another way."}
], "tools": [...]}
```

### 3. Memory Operations

Train the model to use memory tools appropriately:

**Searching memory:**
```jsonl
{"messages": [
  {"role": "user", "content": "what did we talk about yesterday?"},
  {"role": "assistant", "content": "<tool_call>\n{\"name\": \"memory_search\", \"arguments\": {\"query\": \"conversation yesterday\", \"days\": 2}}\n</tool_call>"},
  {"role": "user", "content": "<tool_response>\n[2024-01-15] Discussed setting up the Discord bot...\n</tool_response>"},
  {"role": "assistant", "content": "Yesterday we worked on setting up the Discord bot integration..."}
]}
```

**Writing to memory:**
```jsonl
{"messages": [
  {"role": "user", "content": "remember that my preferred editor is neovim"},
  {"role": "assistant", "content": "<tool_call>\n{\"name\": \"memory_write\", \"arguments\": {\"content\": \"User prefers neovim as their editor\", \"type\": \"preference\"}}\n</tool_call>"},
  {"role": "user", "content": "<tool_response>\nSaved to MEMORY.md\n</tool_response>"},
  {"role": "assistant", "content": "Got it, I'll remember you prefer neovim."}
]}
```

### 4. Visual Tasks (Qwen3-VL)

Train the model to use screenshots and analyze images:

**Taking screenshots:**
```jsonl
{"messages": [
  {"role": "user", "content": "what's on my screen right now?"},
  {"role": "assistant", "content": "<tool_call>\n{\"name\": \"screenshot\", \"arguments\": {}}\n</tool_call>"},
  {"role": "user", "content": [
    {"type": "text", "text": "<tool_response>\nScreenshot captured\n</tool_response>"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
  ]},
  {"role": "assistant", "content": "I can see VS Code with a TypeScript file open, a terminal in the bottom panel running bun dev, and Firefox in the background showing GitHub."}
]}
```

**Analyzing provided images:**
```jsonl
{"messages": [
  {"role": "user", "content": [
    {"type": "text", "text": "what's wrong with this error?"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
  ]},
  {"role": "assistant", "content": "The error shows a TypeScript type mismatch: you're passing a `string` where `number` is expected on line 42. The function `calculateTotal` expects numeric arguments."}
]}
```

**Deciding when NOT to screenshot:**
```jsonl
{"messages": [
  {"role": "user", "content": "what's the current directory?"},
  {"role": "assistant", "content": "<tool_call>\n{\"name\": \"exec\", \"arguments\": {\"command\": \"pwd\"}}\n</tool_call>"}
]}
```

Visual tasks require judgment about when a screenshot adds value versus when text-based tools suffice.

### 5. Personality and Voice

Generate conversations that reflect the desired personality from SOUL.md:

```jsonl
{"messages": [
  {"role": "system", "content": "You are egirl... [SOUL.md content]"},
  {"role": "user", "content": "you're being too formal"},
  {"role": "assistant", "content": "my bad, I'll dial it back. what do you need?"}
]}
```

Include examples of:
- Appropriate tone for different contexts (casual chat vs technical work)
- Handling ambiguous requests
- Declining inappropriate asks
- Staying on task without being robotic

## Data Generation Pipeline

```
┌─────────────────┐
│  Seed Examples  │  ← Write 20-50 high-quality examples per category manually
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Claude Expansion│  ← Generate variations via API
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Validation    │  ← Run tool calls against actual tools, verify outputs
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Deduplication  │  ← Embedding similarity, remove near-duplicates
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Format & Export │  ← JSONL matching Qwen3 template exactly
└─────────────────┘
```

## Seed Example Guidelines

When writing seed examples:

1. **Use real tool schemas** — Load definitions from `src/tools/builtin/`
2. **Include realistic outputs** — Tool responses should look like actual command output
3. **Vary complexity** — Mix simple and multi-step tasks
4. **Cover edge cases** — Errors, ambiguous requests, missing context
5. **Match the voice** — Write assistant responses in the target personality

## Expansion Prompts

For Claude to generate variations:

```
Given this seed example of an agent using tools:

{seed_example}

Generate 10 variations that:
- Use different but related user requests
- Maintain the same tool-calling pattern
- Vary the specifics (file paths, commands, etc.)
- Keep responses in the same voice/style

Output as JSONL, one example per line.
```

## Validation Checklist

Before including an example in training data:

- [ ] Tool calls parse correctly with `parseToolCalls()`
- [ ] Tool names exist in the registry
- [ ] Arguments match the tool's parameter schema
- [ ] Tool response format matches what the tool actually returns
- [ ] No hallucinated file paths or commands
- [ ] Assistant response is appropriate given the tool output

## File Structure

```
data/
├── seeds/
│   ├── routing.jsonl          # Manual routing examples
│   ├── tool-single.jsonl      # Single tool call seeds
│   ├── tool-chain.jsonl       # Multi-tool seeds
│   ├── tool-errors.jsonl      # Error handling seeds
│   ├── memory.jsonl           # Memory operation seeds
│   └── personality.jsonl      # Voice/style seeds
├── generated/
│   └── ...                    # Claude-expanded examples
├── validated/
│   └── ...                    # Post-validation examples
└── final/
    ├── routing.jsonl          # Ready for router training
    └── agent.jsonl            # Ready for agent training
```

## Common Mistakes to Avoid

1. **Too many successful tool calls** — Include failures and edge cases
2. **Unrealistic tool outputs** — Use actual command output, not summaries
3. **Ignoring the "no tool needed" case** — 40% of examples should answer directly
4. **Inconsistent formatting** — Whitespace in `<tool_call>` tags must match exactly
5. **Overfitting to happy paths** — Real usage includes typos, vague requests, interruptions
