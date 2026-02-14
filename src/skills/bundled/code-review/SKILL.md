---
openclaw:
  requires:
    bins: ["git"]
  emoji: "\uD83D\uDD0D"
egirl:
  complexity: "remote"
  canEscalate: true
  escalationTriggers: ["review", "code review", "PR review", "check this code"]
---

# Code Review

Review code changes for quality, bugs, and style issues.

## When to Use

Activate when the user asks you to review code, look over a diff, check a pull request, or evaluate code quality.

## Instructions

1. Use `git_diff` or `read_file` to get the code under review
2. Analyze for:
   - **Bugs**: Logic errors, off-by-one, null/undefined access, race conditions
   - **Security**: Injection, XSS, data exposure, unsafe deserialization
   - **Performance**: Unnecessary allocations, O(n^2) loops, missing indexes
   - **Readability**: Unclear names, long functions, deep nesting
   - **Error handling**: Swallowed errors, missing edge cases
3. Provide specific, actionable feedback with line references
4. Suggest concrete fixes with code examples when applicable
5. Note what's done well — not everything needs criticism

## Output Format

Structure feedback as:
- **Critical** — bugs or security issues that must be fixed
- **Suggestions** — improvements worth considering
- **Nits** — style or minor readability issues (keep brief)

Skip sections with no findings rather than saying "none found."
