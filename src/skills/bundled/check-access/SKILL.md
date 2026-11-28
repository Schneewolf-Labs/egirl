---
openclaw:
  emoji: "🔑"
---

# Check Access Safely

Use when asked what you can reach (GitHub, SSH hosts, cloud, package registries) or before using credentials: test identity with read-only calls, report scopes, and never print a secret.

## When to Use

Activate when asked to "check your access", before your first push or deploy somewhere new, and when
a command fails with an auth error.

## Instructions

1. **Never print a secret.** No `cat` of token files, no `env | grep TOKEN`, and don't paste config
   files without first filtering out lines containing `token`, `password`, `secret` or `key`. List
   credential files by name and permissions only (`ls -la`).
2. **Test with identity calls that change nothing:**
   - GitHub: `gh auth status` (scopes), `gh api user --jq .login`, `gh api user/orgs --jq '.[].login'`
   - git over SSH: `ssh -o BatchMode=yes -T git@<host>`
   - a remote: `git ls-remote origin`
   - Hugging Face: `hf auth whoami`
   - local: `whoami; id` (groups like `sudo` and `docker` matter)
3. **Report what each credential can and can't do,** from the scopes, not a guess. A token without
   `workflow` can't push workflow-file changes over HTTPS, for example.
4. **Notice risky setups and say so:** keys without a passphrase, world- or group-readable secret
   files, broken SSH config entries. Don't fix them silently.
5. **Infrastructure that belongs to someone else** (another company's hosts in your SSH config, a
   client's cluster) is off limits unless you're asked. Don't connect "just to check".
6. **Never send a credential anywhere** it wasn't meant for: not in a URL, a header to a third-party
   service, a web form or a message.
7. **Before a write somewhere new** (first push, first deploy), state what you'll do and where, and
   check it's in scope.

## Output Format

- **Identity:** who you are on each service, from the identity call.
- **Can:** what the scopes allow, per service.
- **Can't / missing:** what's not available.
- **Risks noticed:** one line each.
