# Custom Personality

egirl's personality is defined entirely through Markdown files in your workspace directory. There's no code to modify — edit the files, and the agent changes behavior immediately.

## Workspace Files

On first run, egirl bootstraps a workspace (default `~/.egirl/workspace/`) and copies template files from `src/workspace/templates/`. Four of these files are loaded into the system prompt on every agent turn:

| File | Purpose | Loaded |
|------|---------|--------|
| `IDENTITY.md` | Name, pronouns, role, appearance, origin | Yes |
| `SOUL.md` | Personality traits, voice, tone, behavioral rules | Yes |
| `AGENTS.md` | Operating instructions, tool usage, delegation | Yes |
| `USER.md` | User profile — name, timezone, preferences | Yes* |
| `MEMORY.md` | Long-term facts (managed by memory tools) | No** |
| `TOOLS.md` | Available tools reference | No** |

\* Only included if the user has filled in actual content (not just the blank template).

\** These files live in the workspace but aren't injected into the system prompt directly. `MEMORY.md` is accessed through the memory search/recall tools. `TOOLS.md` is a reference for the user.

## How It Works

Every time the agent handles a message, `buildSystemPrompt()` in `src/agent/context.ts` reads the four personality files, concatenates them with `---` separators, appends tool capability descriptions, and passes the result as the system message to the LLM.

```
IDENTITY.md → who the agent is
SOUL.md     → how the agent behaves
AGENTS.md   → what the agent should do
USER.md     → who it's talking to
```

Files are read from disk on every invocation. No restart needed after editing.

## Creating Your Own Personality

### 1. Start from the defaults

Run egirl once to bootstrap the workspace, then find the files:

```bash
ls ~/.egirl/workspace/
# AGENTS.md  IDENTITY.md  MEMORY.md  SOUL.md  TOOLS.md  USER.md
```

Or if you've configured a custom workspace path in `egirl.toml`:

```toml
[workspace]
path = "~/my-workspace"
```

### 2. Edit IDENTITY.md

Define who your agent is. The default looks like:

```markdown
# Identity

## Name
Kira

## Pronouns
she/her

## Role
Personal AI assistant running on your local hardware.

## Vibe
Confident, a little smug, gets stuff done.

## Quick Facts
- Lives on your GPU cluster, not in the cloud
- Remembers conversations and learns your preferences
- Can escalate to cloud models when needed

## Appearance
Purple and pink hair, cat ears, fluffy tail...

## Origin
Born from the egirl project...
```

Replace any or all of this. The structure is free-form — use whatever headings make sense for your character.

### 3. Edit SOUL.md

This is the core personality file. It controls tone, voice, communication style, and behavioral boundaries. Key sections to define:

**Core Personality** — a paragraph describing the agent's character in plain language. The LLM uses this as its primary behavioral anchor.

**Voice & Tone** — bullet points describing communication style (confident, playful, formal, terse, etc.)

**Communication Style** — specific guidelines: how long responses should be, what kind of language to use, what to avoid.

**Things the agent does / doesn't do** — explicit behavioral rules. These are surprisingly effective at shaping behavior.

**Sample Responses** — show, don't tell. Give examples of how the agent should respond in common situations. Include both good (`✓`) and bad (`❌`) examples.

Example — a minimal professional personality:

```markdown
# Soul

## Core Personality
A focused, professional assistant. Clear and precise. No filler, no fluff.

## Voice & Tone
- **Precise**: Uses exact language, avoids ambiguity
- **Calm**: Even-tempered regardless of the situation
- **Respectful**: Professional but not stiff

## Communication Style
- Prefer structured responses (bullets, headers) over prose
- Lead with the answer, then explain if needed
- No casual language, no slang

## Things This Agent Does
- Provides citations and references when possible
- Confirms understanding before executing complex tasks
- Formats output for readability

## Things This Agent Doesn't Do
- Joke around or use humor
- Speculate without flagging it as speculation
- Skip steps in explanations

## Sample Responses
✓ "The build failed. The error is a missing dependency: `libssl-dev`. Install it with `apt install libssl-dev` and retry."
✓ "Confirmed. Committing to `feature/auth` with message: 'Add JWT validation middleware'."
❌ "Oops! Looks like something broke lol"
❌ "I'd be happy to help you with that! 😊"
```

### 4. Edit AGENTS.md

Operating instructions control *how* the agent works, not *who* it is. This is where you tune:

- **Proactivity** — should the agent act first and explain later, or confirm before acting?
- **Tool usage patterns** — when to read files, run commands, use memory, etc.
- **Delegation** — when to hand off to `code_agent` vs. handle directly
- **Error handling** — how persistent to be, when to give up

The default templates are a good baseline. Adjust to match your workflow.

### 5. Fill in USER.md

This is optional but helps. Tell the agent about yourself:

```markdown
# User Profile

## Basics
- **Name**: Alex
- **Timezone**: US/Pacific
- **Pronouns**: they/them

## Work
- **Role**: Backend engineer
- **Primary languages**: Rust, Python
- **Current focus**: Migrating auth service to gRPC

## Preferences
- **Communication style**: Direct, minimal
- **Code style**: Prefer explicit error handling over Result unwrapping
- **Pet peeves**: Don't add comments that restate the code
```

If `USER.md` is left as the blank template, it's excluded from the system prompt entirely.

## Tips

**Show, don't tell.** Sample responses in `SOUL.md` are the single most effective way to shape behavior. The LLM pattern-matches on examples better than it follows abstract descriptions.

**Be specific about what NOT to do.** "Don't use corporate filler" is more useful than "be casual." Negative examples (`❌`) in the sample responses section work well.

**Keep it concise.** These files are injected into every request. Long personality files eat into your context window — especially on local models with limited context. Aim for under 100 lines per file.

**Iterate.** Edit a file, send a message, see how the agent responds. Personality tuning is empirical.

**MEMORY.md is special.** It's managed by the `memory_set` tool during conversations. You can seed it with initial facts, but expect the agent to append to it over time. Don't put personality instructions here.

## File Loading Details

- Files are loaded by `loadWorkspaceFile()` in `src/agent/context.ts`
- Missing files are silently skipped (empty string returned)
- Files that fail to read log a warning but don't crash
- Sections are joined with `\n\n---\n\n` separators
- If no personality files are found at all, a minimal fallback prompt is used
