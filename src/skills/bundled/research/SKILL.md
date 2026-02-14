---
openclaw:
  requires:
    bins: []
  emoji: "\uD83D\uDCDA"
egirl:
  complexity: "remote"
  canEscalate: true
  escalationTriggers: ["research", "look up", "find out", "investigate", "what is"]
---

# Research

Investigate topics, gather information from the web, and produce structured summaries.

## When to Use

Activate when the user asks you to research a topic, look something up, compare technologies, or gather background information for a decision.

## Instructions

1. Use `web_research` to fetch relevant sources
2. Read multiple sources when possible — don't rely on a single page
3. Cross-reference claims between sources
4. Distinguish between facts, opinions, and speculation
5. Note when information may be outdated or contested

## Output Format

Structure research results as:
- **Summary** — 2-3 sentence answer to the core question
- **Key Findings** — bullet points of the most important facts
- **Sources** — list URLs you actually fetched and used

If the research is for a technical decision, add:
- **Trade-offs** — pros and cons of each option
- **Recommendation** — your assessment based on the findings

Use `memory_set` to store findings the user might need again later.
