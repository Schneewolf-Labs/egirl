# MCP servers

egirl can connect to [Model Context Protocol](https://modelcontextprotocol.io) servers and offer
their tools to the agent alongside the builtins.

Nothing downstream knows the difference. An MCP tool reaches the executor in the same shape as
`read_file`, so safety rules, the permission supervisor and the system prompt
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

### Witchgrid

[Witchgrid](https://github.com/Schneewolf-Labs/Witchgrid)'s control plane serves MCP at `POST /mcp`.
Connecting it lets the operator list the fleet's nodes, services, profiles and model catalog, and
spawn, stop or swap models on it, as ordinary tool calls. That is the "escalate to tools" rule
applied to the inference fleet: when a job wants a different or bigger model loaded somewhere, the
operator does it with a tool instead of egirl growing any model-routing logic.

```toml
[[mcp.servers]]
name = "witchgrid"
url = "http://witchgrid.lan:8765/mcp"
headers = { Authorization = "Bearer $WITCHGRID_SHARED_SECRET" }
```

The tools arrive as `witchgrid_list_nodes`, `witchgrid_list_services`, `witchgrid_list_profiles`,
`witchgrid_list_catalog`, `witchgrid_fleet_status`, `witchgrid_resolve_profile`,
`witchgrid_spawn_service` and `witchgrid_stop_service`. Leave out `headers` when the control plane
runs without `WITCHGRID_SHARED_SECRET`. Witchgrid answers every request with buffered JSON: no SSE,
no session id, `405` on GET and `202` for notifications. The client handles all of that as it is
(see `test/mcp/witchgrid-http.test.ts`).

To have egirl's own operator endpoint located through Witchgrid as well, see `[local.witchgrid]` in
[configuration.md](configuration.md).

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
