---
openclaw:
  emoji: "🏷️"
---

# Cut a Release

Use when tagging or publishing a version (a library, a CLI, a package formula): green main first, bump the way the repo does, tag, watch the release job, check artifacts, update dependents.

## When to Use

Activate when asked to release, tag, publish or bump a version, or to update a package manager
formula, lockfile or pin to a new release.

## Instructions

1. **Releasing is public.** Make sure you've been asked to do it, and say what version you're cutting.
2. **Everything you're shipping is merged, and main is green** on the exact commit you'll tag: every
   workflow complete and passing (`gh run list --commit <sha>`). Wait for the slow ones.
3. **Bump the way the repo already does.** Read the previous release's bump commit (`git show <tag>`)
   and change the same files the same way. Don't invent a new process.
4. **Tag that exact commit** and push the tag. Check that the remote has it: `git ls-remote origin
   refs/tags/<tag>`.
5. **Watch the release workflow to the end.** If it fails, read the failing step. Common causes:
   - the job's token can't create releases (it needs `permissions: contents: write`);
   - tests fail against the dependency version the release job pins;
   - a toolchain install failed.
6. **Check the artifacts, not the release page.** Download one, run `--version`, and run one real
   input through it.
7. **Update what depends on it:** package formulas (recompute the sha256 from a fresh download;
   never guess it), lockfiles, pins in other repos' CI. Pin downstream to a version that actually
   contains the fix it needs.
8. **Don't move a published tag.** If a tag has no release and nobody can have used it, you can
   delete and re-create it. Say that you did, and why. Once a release exists, cut a new patch
   version instead.

## Output Format

- **Released:** version, tagged commit, release URL, number of artifacts.
- **Verified:** which artifact you ran, and what it printed.
- **Downstream:** each formula, pin or lockfile updated, with its PR.
- **Problems:** anything that failed and how it was fixed, including moved tags.
