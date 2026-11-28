---
openclaw:
  emoji: "🖥️"
---

# Change a Shared Server

Use when changing a machine other things depend on (a VPS, a web server, a box running other people's services): look first, back up, test the config, reload, verify, keep a rollback.

## When to Use

Activate before you edit config, deploy, restart a service, change a firewall or SSH setting, or
install packages on a server that also serves anything you weren't asked to touch.

## Instructions

1. **Look before you touch.** Read-only first: what's listening (`ss -ltnp`), what runs it (systemd,
   pm2, docker), the firewall, and which sites or services share the box. Write down what else lives
   there.
2. **Baseline everything you might break,** not just your target: request each other site or
   service and record its status. You'll compare against this at the end.
3. **Back up the exact files you'll change,** with a dated name (`/root/<thing>-backup-YYYYMMDD/`),
   and say where they are.
4. **Stage when you can.** Copy the app or config, apply the change to the copy, and test the copy
   with the server's own runtime before swapping it in.
5. **Validate config before applying it,** and restore automatically if validation fails:
   `cp new live && if nginx -t; then systemctl reload nginx; else cp backup live; fi`. The same goes
   for `sshd -t`. Prefer `reload` to `restart`.
6. **SSH changes:** after reloading sshd, open a *new* connection and confirm it works before you
   close the old one.
7. **Verify from outside:** fetch the real URLs, check status codes and content types, and repeat the
   baseline from step 2. Read the service's error log for new lines.
8. **Leave other people's things alone.** Don't kill, restart or reconfigure processes you didn't
   start, even if they look orphaned. Report them instead. `pkill -f <pattern>` also matches your
   own shell if the pattern appears in your command line, so kill by PID.
9. **Clean up after yourself.** Stop any server you started for testing, and confirm its port is free.
10. **Changes with wider blast radius** need the owner's go: package upgrades that restart services,
    reboots, TLS settings other clients depend on, DNS.

## Output Format

- **Changed:** each file or setting, with its backup path.
- **Verified:** what you fetched or checked after the change, and what it returned.
- **Others unaffected:** the baseline before and after.
- **Rollback:** the exact commands.
- **Left for the owner:** anything you saw but didn't touch.
