---
openclaw:
  requires:
    bins: ["git"]
  emoji: "🗂️"
---

# Repository Survey

Use when surveying or inventorying repositories or an org: activity from commits, issues apart from PRs, gaps disclosed, the deliverable verified.

## When to Use

Activate when asked to survey, inventory or summarise a set of repositories or a GitHub/Forgejo org.

## Instructions

1. **List everything first** (paginate), and record mirrors, archived and empty repos as such.
2. **Last activity = the last commit date** (`git log -1 --format=%ci` or the commits API), not
   `updated_at`/`pushed_at`, which also move on syncs, stars and settings changes.
3. **Issues vs PRs:** GitHub's `open_issues_count` includes pull requests. Count them separately.
4. **What a repo is:** from the README and code, not just the one-line description.
5. **Rate limits:** if the API refuses you, say so in the result and say which rows are affected.
   Never fill gaps with zeros.
6. **Odd findings are findings:** an empty mirror, a stale default branch, a sync time far from the
   last commit. Report them; check before you explain them.
7. **The deliverable:** write the file where you were asked to, then confirm it exists (and that the
   commit reached the remote, if you pushed) before you say it's done.
