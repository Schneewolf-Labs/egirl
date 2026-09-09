# Skills System

Skills are reusable instruction sets written in Markdown that extend egirl's capabilities. The format is compatible with OpenClaw.

## Skill Format

A skill is a Markdown file (`SKILL.md`) with optional YAML frontmatter:

```markdown
---
openclaw:
  requires:
    bins: ["git"]
    env: ["GITHUB_TOKEN"]
  emoji: "🔀"
  homepage: "https://github.com/example/skill"
---

# Git Operations

Instructions for handling git operations...
```

### Frontmatter Fields

| Field | Type | Description |
|-------|------|-------------|
| `openclaw.requires.bins` | string[] | Required system binaries (e.g., `["git", "docker"]`) |
| `openclaw.requires.env` | string[] | Required environment variables |
| `openclaw.requires.config` | string[] | Required config files |
| `openclaw.primaryEnv` | string | Primary environment variable for the skill |
| `openclaw.emoji` | string | Display emoji (used in `status` output and headings) |
| `openclaw.homepage` | string | URL for more information |

The frontmatter is optional; skills without it are content-only.

### `egirl.command`: a skill as a slash command

A skill can register itself as a slash command, on every surface at once (terminal, web
console, Discord, XMPP, Matrix, Telegram):

```markdown
---
egirl:
  command:
    name: draw                      # defaults to the skill name, slugged
    description: Draw a picture     # one line for /help and the Discord picker
    args: what to draw              # omit if the command takes no arguments
    permission: allowed             # everyone (default) | allowed | owner
---
# Drawing
Call `niku_generate` with a Danbooru-style prompt built from the request...
```

`/draw a fox in a hat` then runs an ordinary turn whose message is the skill's instructions
plus the request. Nothing is bypassed: the command is discoverability and a permission gate
over natural language, and "please draw a fox" keeps working without it. Built-in commands
(`/status`, `/think`, ...) always win over a custom name.

`permission` is checked against who is asking, as the channel knows them: `allowed` means the
channel's allowed-users list (an empty list allows everyone), `owner` means the channel's owner
list (`owner_users` for Discord). The terminal is always the owner. A denied command is answered
with a lock message and never reaches the model.

On Discord the custom commands are also registered as application commands at login, so users
see them with autocomplete; an interaction is handled exactly like the typed form, on the same
session. Registration is best effort -- if it fails, typed `/draw` still works.

Because an agent can write a SKILL.md (that is what `/learn` does), an agent can register its
own commands.

## Skill Discovery

Skills are loaded from directories configured in `egirl.toml`:

```toml
[skills]
dirs = ["~/.egirl/skills", "{workspace}/skills"]
```

The loader scans each directory for `SKILL.md` files. Each skill's directory becomes its `baseDir`.

### Directory Structure

```
~/.egirl/skills/
├── git-ops/
│   └── SKILL.md
├── code-review/
│   └── SKILL.md
└── research/
    └── SKILL.md
```

## Skill Parsing

The parser (`src/skills/parser.ts`) handles:

1. **Frontmatter extraction**: YAML between `---` delimiters is parsed into `SkillMetadata`
2. **Name extraction**: First `# Heading` in the content becomes the skill name
3. **Description extraction**: First non-heading text after the heading becomes the description

Skills without frontmatter are still valid — they're treated as content-only skills with empty metadata.

## SkillManager

The `SkillManager` class (`src/skills/index.ts`) provides a registry for loaded skills:

```typescript
interface SkillManager {
  get(name: string): Skill | undefined
  getAll(): Skill[]
  getEnabled(): Skill[]
  enable(name: string): void
  disable(name: string): void
}
```

Skills can be enabled or disabled at runtime. Only enabled skills are active.

## Skill Interface

```typescript
interface Skill {
  name: string           // Extracted from first heading
  description: string    // First paragraph after heading
  content: string        // Full markdown content (after frontmatter)
  metadata: SkillMetadata
  baseDir: string        // Directory containing the SKILL.md
  enabled: boolean       // Whether the skill is active
}

```

## Creating a Skill

1. Create a directory under one of the configured skill dirs
2. Add a `SKILL.md` file with instructions
3. Optionally add YAML frontmatter for metadata
4. Restart egirl to pick up the new skill

### Example Skill

```markdown
---
openclaw:
  emoji: "🔍"
---

# Code Review

Review code changes for quality, bugs, and style.

## Instructions

When asked to review code:
1. Read the file or diff provided
2. Check for bugs, security issues, and style problems
3. Provide specific, actionable feedback
4. Suggest improvements with code examples

## Focus Areas

- Error handling: Are errors caught and handled appropriately?
- Security: Any injection, XSS, or data exposure risks?
- Performance: Unnecessary allocations, O(n²) loops?
- Readability: Clear names, reasonable function length?
```

## Bundled Skills

`src/skills/bundled/` contains skills that ship with egirl: `code-review` and `research`. These are loaded alongside user-installed skills from the configured `[skills] dirs`.
