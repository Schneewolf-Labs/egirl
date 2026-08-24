# Tool Calling Format

Tool calling is **dialect-pluggable** (`src/tools/dialects.ts`, selected by `[local] tool_format`).
Tool definitions always go in the system prompt and calls are always parsed out of raw assistant
text — we never send the OpenAI `tools` parameter, because a server that parses `<tool_call>`
itself would return structured `tool_calls` and hide the content our parser needs.

| dialect | asks for | notes |
|---|---|---|
| `qwen3` | JSON inside `<tool_call>` | the Qwen3 chat template; the default shape |
| `qwen35` | `<function=NAME>` / `<parameter=KEY>` inside `<tool_call>` | Qwen3.5-MoE's own syntax |
| `laguna` | `<tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value>` | Laguna's template |
| `deepseek` | JSON inside `<tool_call>` (Qwen3 form) | DeepSeek v4; parses its native `<｜DSML｜tool_call>` back |
| `auto` | asks in Qwen3 form, accepts **any** of the above back | use when unsure |

Ask in the model's own dialect when you know it. A model told to use a foreign syntax tends to
fall back to the one it was trained on, which a parser expecting only the foreign form drops on
the floor — so every dialect here also accepts the others on the way back.

The Qwen3 form below is documented in full because it is the default and the fine-tuning target.

## Qwen3 (default)

Target the native Qwen3 chat template for tool calling. This enables fine-tuning on the same format.

## Format Specification

**Tool definitions** go in the system prompt wrapped in `<tools>` tags:
```
<|im_start|>system
{system prompt content}

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "read_file", "description": "...", "parameters": {...}}}
{"type": "function", "function": {"name": "exec", "description": "...", "parameters": {...}}}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call><|im_end|>
```

**Tool calls** from the assistant use `<tool_call>` tags:
```
<|im_start|>assistant
Let me read that file for you.
<tool_call>
{"name": "read_file", "arguments": {"path": "/etc/hosts"}}
</tool_call><|im_end|>
```

**Tool responses** go back as user messages with `<tool_response>` tags:
```
<|im_start|>user
<tool_response>
127.0.0.1 localhost
::1 localhost
</tool_response><|im_end|>
```

**Multiple tool responses** batch together in one user message:
```
<|im_start|>user
<tool_response>
result from first tool
</tool_response>
<tool_response>
result from second tool
</tool_response><|im_end|>
```

## Key Implementation Notes

- Tool responses use `role: "user"` with `<tool_response>` tags, not a separate "tool" role
- No `tool_call_id` — responses match calls by position
- Parse tool calls with: `/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g`
- Always include `\n` after opening and before closing tags (matches training data)
- The model may generate multiple `<tool_call>` blocks in a single turn for parallel tool use
- Do not use `</tool_call>` as a stop token — the model stops naturally after generating all tool calls

## Training Data Format

JSONL for fine-tuning should match this exact structure:
```jsonl
{"messages": [
  {"role": "system", "content": "You are egirl..."},
  {"role": "user", "content": "what's in config.toml?"},
  {"role": "assistant", "content": "<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"config.toml\"}}\n</tool_call>"},
  {"role": "user", "content": "<tool_response>\n[workspace]\npath = \"~/.egirl\"\n</tool_response>"},
  {"role": "assistant", "content": "Your config.toml contains the workspace settings..."}
], "tools": [{"type": "function", "function": {"name": "read_file", ...}}]}
```
