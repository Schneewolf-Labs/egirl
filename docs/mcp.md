# MCP servers

egirl can connect to [Model Context Protocol](https://modelcontextprotocol.io) servers and offer
their tools to the agent alongside the builtins.

Nothing downstream knows the difference. An MCP tool reaches the executor in the same shape as
`read_file`, so safety rules, the energy budget, the permission supervisor and the system prompt
all treat it identically.

## Configuration

```toml
# stdio: egirl spawns the process and talks to it over its pipes
[[mcp.servers]]
name = "wald"
command = "wald-mcp"
args = ["--stdio"]

# http: egirl connects to a running endpoint
[[mcp.servers]]
name = "wald"
url = "http://localhost:8090/mcp"
timeout_ms = 30000
```

A value beginning with `$` in `env` or `headers` is read from the environment, so tokens live in
`.env` rather than in a config file that gets committed:

```toml
[[mcp.servers]]
name = "wald"
url = "https://wald.internal/mcp"
headers = { Authorization = "$WALD_TOKEN" }
```

## Tool names

Tools are exposed as `<server>_<tool>`: a server named `wald` offering `search` becomes
`wald_search`.

The prefix is not decoration. Two servers offering `search` would otherwise shadow each other, and
the model would call one believing it was the other — a failure that looks like a wrong answer
rather than a configuration mistake. It also keeps the origin of a call visible in transcripts.

## When a server is down

Servers are connected concurrently at startup. One that fails to start, refuses the connection or
errors while listing its tools is logged and skipped:

```
WARN [mcp] Could not connect to 'wald': Executable not found in $PATH: "wald-mcp"
```

Its tools are absent; everything else runs normally. This is deliberate — these are other people's
processes and network endpoints, and adding a second server should never make the agent less
reliable than it was with one.

A tool that fails at call time returns a failed `ToolResult` with the server's message, so the
model can react rather than seeing an empty response. MCP reports tool-level failure in-band via
`isError` rather than as an exception, and that is mapped to `success: false`.

## Content types

MCP returns an array of typed content blocks, flattened into the single string egirl tools return:

- **text** — used as-is
- **image** — passed through as a `data:` URL, which egirl already handles (see the screenshot
  tool); the result is marked `isImage`
- **resource** — its text, or `[resource: <uri>]` when there is none
- anything else — described as `[<type> content]` rather than dropped, so a model is never handed
  an empty result when something did come back
