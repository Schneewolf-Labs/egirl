# Tool Calling Format (Qwen3)

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
- Stop token: `</tool_call>` signals end of tool call generation

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
