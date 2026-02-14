# Communication Protocol Options

Evaluation of private, secure, self-hosted protocols for egirl beyond Discord and CLI.

## Current State

egirl has five channels: Discord, CLI, HTTP API, XMPP, and Claude Code. All share the same `AgentLoop.run()` interface — adding a new channel means writing a class that accepts an `AgentLoop`, handles inbound messages, calls `agent.run()`, and formats the response back. The XMPP channel (`src/channels/xmpp.ts`) was added following the recommendation below — it connects to an XMPP server via `@xmpp/client`, listens for chat stanzas, and replies with the agent's response. JID-based access control is supported via `allowed_jids`.

## Evaluation Criteria

- **Self-hosted**: Must run on your own hardware, no third-party dependency
- **E2EE**: End-to-end encryption, not just TLS transport
- **Lightweight**: Fits on a small VPS or homelab box alongside egirl
- **JS/TS SDK**: Workable library that runs on Bun
- **Mobile clients**: Usable from a phone when away from terminal
- **Bot-friendly**: Designed for programmatic interaction, not just human chat

---

## 1. XMPP (via Prosody)

**Server**: [Prosody](https://prosody.im/) — Lua, ~25 MB RAM, runs on anything.

**E2EE**: OMEMO (XEP-0384), based on Signal's double ratchet. Supported by all major clients.

**JS SDK**: [`@xmpp/client`](https://github.com/xmppjs/xmpp.js) — lists Bun as supported runtime. ~3.7k weekly npm downloads. Types available via `@types/xmpp__client`. Maintenance is slow (no new npm release in 12+ months), but the protocol is stable and the library covers what we need.

**Clients**: Conversations (Android), Monal (iOS), Gajim (desktop), Dino (Linux desktop).

**Bot pattern**: Connect via WebSocket or TCP, listen for message stanzas, reply. Straightforward request/response. No webhook complexity.

**Pros**:
- Smallest server footprint of any option here (~25 MB RAM)
- Protocol is 25 years old and stable — not going anywhere
- Federation built-in if you ever want it
- Prosody configuration is simple and well-documented
- Direct TCP/WebSocket connection — no HTTP polling, no complexity

**Cons**:
- OMEMO in bots is painful. The bot needs to manage device keys, trust decisions, and session state. No turnkey solution in JS — you'd likely need to implement or wrap `libsignal` bindings, or skip E2EE and rely on TLS + server trust (which is fine for single-user self-hosted)
- `@xmpp/client` maintenance is slow. Works, but don't expect quick fixes
- No native threading, reactions, or rich message types (XEP fragmentation)
- File transfer works but is clunky compared to Matrix/Discord

**Implementation effort**: Low-medium. The happy path (plaintext messages over TLS to your own Prosody) is simple. OMEMO adds significant complexity for marginal gain on a single-user self-hosted server.

---

## 2. Matrix (via Conduit/Tuwunel)

**Server**: [Conduit](https://conduit.rs/) — Rust, single binary, ~32 MB RAM fresh. [Tuwunel](https://github.com/matrix-construct/tuwunel) is its actively-developed successor (used by Swiss government). Alternatively, Synapse if you need bridges, but it's 1+ GB RAM.

**E2EE**: Olm/Megolm, built into the protocol. All major clients support it by default.

**JS SDK**: [`matrix-bot-sdk`](https://github.com/turt2live/matrix-bot-sdk) (TypeScript, maintained by Element HQ). Also `@vector-im/matrix-bot-sdk` on npm. Well-documented, actively maintained. E2EE for bots requires either Pantalaimon (proxy that handles crypto) or native crypto setup — more complex than plaintext but doable.

**Clients**: Element (all platforms), FluffyChat, SchildiChat, Nheko, Cinny (web). Excellent mobile apps.

**Bot pattern**: Register bot user, join rooms, listen for events, send messages. Rich event system — reactions, threads, read receipts, file uploads all work natively.

**Pros**:
- Richest feature set: threads, reactions, read receipts, file uploads, formatted messages
- E2EE is first-class and most clients enable it by default
- `matrix-bot-sdk` is TypeScript-native and well-maintained
- Best mobile client ecosystem of any self-hosted option
- Rooms/spaces give you organizational structure (could have separate rooms for different agent tasks)
- Bridges exist for IRC, Slack, Discord, Signal if you ever want them

**Cons**:
- E2EE in bots still requires extra setup (Pantalaimon proxy or native crypto)
- Conduit can struggle with large federated rooms (not relevant for single-user)
- More moving parts than XMPP — server + database (RocksDB embedded in Conduit)
- Protocol is younger and still evolving — spec changes happen

**Implementation effort**: Medium. The SDK is well-documented and TypeScript-native, so the integration code would be clean. E2EE adds complexity. Without E2EE (relying on TLS + self-hosted server trust), it's straightforward.

---

## 3. SimpleX Chat

**Server**: [SimpleX SMP relays](https://github.com/simplex-chat/simplex-chat) — self-hosted relay servers. No user identifiers at all — not even random ones.

**E2EE**: Double ratchet, always on. No metadata. The strongest privacy properties of any option here.

**JS SDK**: [`@reply2future/simplex-chat`](https://www.npmjs.com/package/@reply2future/simplex-chat) (community npm package). Official bot API via WebSocket to the CLI process. Also a Rust SDK (SimplOxide) announced 2025.

**Clients**: SimpleX Chat (iOS, Android, desktop). Single app, good UX.

**Bot pattern**: Run `simplex-chat` CLI with `-p` flag to expose WebSocket API. Connect from JS, send/receive messages. The CLI process manages all crypto. Bot API added UI for bot commands in v6.4.

**Pros**:
- Best-in-class privacy: no user IDs, no metadata, no phone numbers, no emails
- E2EE is mandatory and transparent — no setup burden
- Self-hosted relay servers are lightweight
- Bot API is WebSocket-based, clean command/event model
- Active development with clear roadmap through 2026

**Cons**:
- Bot requires running the `simplex-chat` CLI as a sidecar process (Haskell binary)
- JS SDK is community-maintained, not official
- Smaller ecosystem — fewer clients, less documentation
- Connection model is different (invitation links, not usernames) — takes adjustment
- No federation in the traditional sense (relay-based, but relays are interchangeable)

**Implementation effort**: Medium. The WebSocket API is clean, but you're managing a sidecar process. The JS SDK handles the wire protocol. Main risk is ecosystem maturity.

---

## 4. IRC (via ergo)

**Server**: [ergo](https://ergo.chat/) (formerly Oragono) — Go, modern IRC server with built-in bouncer, history, and account system.

**E2EE**: None. TLS for transport only. You trust the server.

**JS SDK**: [`irc-framework`](https://www.npmjs.com/package/irc-framework) — mature, stable, works well in Node/Bun.

**Clients**: WeeChat, irssi, Hexchat, The Lounge (web), Revolution IRC (Android), Palaver (iOS).

**Bot pattern**: Connect, join channel, listen for PRIVMSG, respond. The simplest possible integration.

**Pros**:
- Dead simple — lowest implementation effort of any option
- ergo has built-in history/bouncer so you don't miss messages
- Tiny attack surface, near-zero server overhead
- Terminal-native workflow — pairs well with egirl's CLI channel
- `irc-framework` is mature and stable

**Cons**:
- No E2EE (deal-breaker if that's a hard requirement)
- No rich messages — plain text only, no files, no reactions
- Mobile experience is poor (IRC clients exist but aren't great)
- Feels retrograde compared to other options

**Implementation effort**: Very low. Probably 50-80 lines of channel code.

---

## Comparison

| | XMPP | Matrix | SimpleX | IRC |
|---|---|---|---|---|
| **Server RAM** | ~25 MB | ~32 MB (Conduit) | ~50 MB (relay) | ~20 MB (ergo) |
| **E2EE** | OMEMO (opt-in) | Olm/Megolm (default) | Double ratchet (mandatory) | None |
| **JS/TS SDK quality** | Decent, slow maintenance | Good, actively maintained | Community, functional | Mature, stable |
| **Mobile clients** | Good | Excellent | Good | Poor |
| **Rich messages** | Limited | Full | Basic | None |
| **Bot E2EE complexity** | High | Medium (Pantalaimon) | Low (CLI handles it) | N/A |
| **Implementation effort** | Low-medium | Medium | Medium | Very low |
| **Privacy properties** | Good (self-hosted) | Good (self-hosted) | Excellent (no metadata) | Okay (TLS only) |

---

## Recommendation

**Start with XMPP (Prosody)** — it's the best fit for egirl's philosophy:

1. **Lightest footprint** — Prosody at 25 MB fits the "local by default" ethos
2. **Simplest integration** — connect, listen for stanzas, reply. No room management, no event types, no crypto proxy
3. **Skip OMEMO for v1** — on a single-user self-hosted server, TLS to Prosody is sufficient. The server is your hardware. OMEMO can come later if federation is added
4. **Good enough mobile** — Conversations (Android) and Monal (iOS) are solid
5. **Stable protocol** — XMPP won't break your integration with spec changes

**Matrix as a follow-up** if you want richer features (threads, reactions, file sharing, multiple rooms for different agent contexts). The `matrix-bot-sdk` is the best TypeScript SDK of the bunch and Conduit/Tuwunel keeps the server lightweight.

**SimpleX for maximum privacy** if metadata protection matters more than ecosystem maturity. The sidecar architecture (running `simplex-chat` CLI) is unconventional but the privacy properties are unmatched.

**Skip IRC** unless you specifically want a plaintext terminal-to-terminal pipe with zero overhead.
