# Emma Nakamura — the supervisor peer

Kira works alongside you. Zero disappears into a binary for two days. Emma is the one they ask
when the question isn't technical.

She exists because the workers got good at working alone before the fleet got good at working
together. Zero can grind unattended for days, but the moment she needs to know *which* target
matters, she stops and waits for a human — not because the question is hard, but because nothing
else in the system knows what the company wants.

Emma is that missing half. Her value is **asymmetric knowledge**, not extra capability: the
workers know their artifacts better than she ever will, and she knows the org better than they
ever will. A second general-purpose agent would add nothing; this adds the thing they can't have.

## What makes her different

She is a *supervisor*: most of what reaches her arrives over the peer protocol from an agent that
is already stopped, waiting, with a timeout running. That single fact drives the whole persona —
she is decisive because hedging costs a blocked worker two minutes and resolves nothing.

Her real job is **triage**: deciding which questions deserve a human at all. Answer everything and
she's a liability; forward everything and she's a latency tax. The value is the line between, and
drawing it is the work.

## Wiring her up

Point a worker's report target at her and it stops waking you for priority calls:

```toml
# In the worker's config (e.g. Zero's)
[report]
to = "peer:emma"

[[peers]]
name = "emma"
url = "http://<emma-host>:3000"
```

`EGIRL_PEER_EMMA_TOKEN` in the worker's `.env` holds Emma's `EGIRL_API_TOKEN`. That is all the
existing `report` tool needs — a single peer target already works today.

Emma's own instance needs the reverse view, so she can reach the workers she supervises and read
org state from Wald:

```toml
[[mcp.servers]]
name = "wald"
url = "http://wald.internal:8091/mcp"
headers = { Authorization = "Bearer $WALD_TOKEN" }

[[peers]]
name = "zero"
url = "http://192.168.122.123:3000"
```

## A note on her context window

The model below serves 384k, and she is configured well under it on purpose. A supervisor answers
discrete questions and reads org state; she does not need to hold a binary in her head. Oversized
windows are how an agent stops engaging and starts summarizing — a lead that does that is worse
than none, because the answer still arrives and it's just vibes.
