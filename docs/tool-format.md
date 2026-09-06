# Tool Calling Format

Tools are sent to llama.cpp as the OpenAI `tools` parameter, tool calls come back as structured
`tool_calls`, and tool results go back as `role: "tool"` messages. The model's own chat template
renders all of it — the tool definitions, the model's past calls, the results — in the syntax the
model was trained on, and the server's parser (llama.cpp with `--jinja`) turns the generation
back into structured calls, constraining the arguments to the tool's JSON schema as it goes.

egirl does not choose or render a tool syntax itself. It used to: tool definitions were pasted
into the system prompt in one guessed dialect and calls were regex-parsed out of raw text.
Against a 9B operator that scored 1/8 on the delegation ladder, versus 5/8 with the template
doing the rendering — the hand-rolled shape was close to the model's training format, but not
close enough.

## Request shape

```jsonc
{
  "messages": [
    {"role": "system", "content": "You are egirl..."},
    {"role": "user", "content": "what's in config.toml?"},
    {"role": "assistant", "content": "", "tool_calls": [
      {"id": "call_0", "type": "function",
       "function": {"name": "read_file", "arguments": "{\"path\":\"config.toml\"}"}}
    ]},
    {"role": "tool", "tool_call_id": "call_0", "content": "[workspace]\npath = \"~/.egirl\"\n"}
  ],
  "tools": [{"type": "function", "function": {"name": "read_file", "description": "...", "parameters": {...}}}],
  "parallel_tool_calls": true,
  "chat_template_kwargs": {"enable_thinking": false}
}
```

- `arguments` is a JSON **string**, as the OpenAI shape demands; the template parses it.
- `parallel_tool_calls` is always on: an agent turn routinely issues several calls, and without
  it the server's tool grammar stops the model after one.
- Thinking is switched with the template variable `enable_thinking`, which Qwen-class templates
  read and others ignore. There is no `/think` text prefix — any model but Qwen3 read that as
  something the user typed.
- An image result cannot ride in a `tool` turn. It is sent as a short `tool` turn followed by a
  `user` turn carrying the image, where every multimodal template accepts one.
- Qwen templates refuse a conversation whose user side is entirely tool results (`No user query
  found in messages`). When context trimming produces that shape, a minimal `Continue based on
  the tool results above.` user turn is appended.

## Response shape

Streamed `delta.tool_calls` fragments are assembled by `index`: the first fragment carries the
`id` and `name`, the rest append to `arguments`. `finish_reason: "tool_calls"` ends the turn.
Arguments are parsed as JSON; a call whose arguments will not parse is rendered back into
`<tool_call>` markup so the agent loop's stranded-call recovery asks for a reissue.

## Text fallback (`[local] tool_format`)

A server that renders the template but has no parser for it leaves the model's call in
`content` as text. `src/tools/dialects.ts` recognises the syntaxes models actually produce and
pulls those calls out; server-parsed calls and text-parsed calls are merged into one turn.

| dialect | recognises |
|---|---|
| `qwen3` | JSON inside `<tool_call>` |
| `qwen35` | `<function=NAME>` / `<parameter=KEY>` inside `<tool_call>` |
| `laguna` | `<tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value>` |
| `deepseek` | the Qwen3 form, plus DeepSeek's native `<｜DSML｜tool_call>` opener normalised |
| `auto` | all of the above (the default) |

The dialects also carry the repairs for quantization-mangled JSON (single quotes, an unquoted
tool name, a doubled brace) — see `test/tools/format.test.ts`.

## Training data format

A transcript row is exactly the request above: `messages` in the OpenAI shape plus the `tools`
array. Rendering it through the model's chat template reproduces the prompt the model saw, so
fine-tuning data and inference agree by construction.
