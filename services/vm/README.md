# VM sandbox

Run an egirl instance inside a disposable VM, and drop files into it from a browser.

## Why a VM

egirl's `path_sandbox`, `command_filter` and permission supervisor all live inside the agent
process. They are useful and they are not a security boundary — the model can be argued past them,
and a binary the agent executes ignores them entirely.

For work where the failure mode is "the host is gone" rather than "the answer is wrong" — reverse
engineering, unknown binaries, untrusted repositories — the boundary needs to be below the agent.

A container is not that boundary. It shares the host kernel, so a single kernel bug ends the
isolation, and "root in a container" is namespaced root, which conflicts with wanting the agent to
genuinely own its machine.

What makes this cheap for egirl specifically: **the operator model runs over HTTP on another
host**, so the guest needs an IP address and nothing else. No GPU passthrough — the part that
usually makes agent VMs painful.

## Setup

```bash
sudo apt install -y qemu-system-x86 libvirt-daemon-system libvirt-clients virtinst genisoimage
sudo usermod -aG kvm,libvirt $USER    # log out and back in

sudo mkdir -p /var/lib/libvirt/images/egirl
sudo chgrp libvirt /var/lib/libvirt/images/egirl
sudo chmod 2775 /var/lib/libvirt/images/egirl
```

The package is `qemu-system-x86`. `qemu-kvm` is a transitional package that no longer exists on
current releases, and apt aborts the entire install rather than skipping it.

## Provision

```bash
services/vm/provision.sh zero \
  --persona ~/.egirl/personas/zero \
  --env-file ~/Projects/egirl/.env.zero \
  --memory 24576 --vcpus 8 --disk 120
```

Creates the domain, waits for cloud-init, installs bun and egirl in the guest, and copies the
persona and env in. Prints the address, the ssh command, and the share path when it finishes.

The guest user has passwordless sudo and a console password — full root over its own machine. The
isolation is the VM, not the account.

**Take the snapshot before the first real run.** Reverting is what makes the VM disposable, and
disposable is what lets the agent work on something hostile without it mattering.

The guest must be **shut off** first:

```bash
virsh -c qemu:///system shutdown zero          # wait for shutoff
virsh -c qemu:///system snapshot-create-as zero clean
virsh -c qemu:///system start zero
```

To revert after a target:

```bash
virsh -c qemu:///system destroy zero
virsh -c qemu:///system snapshot-revert zero clean
virsh -c qemu:///system start zero
```

A snapshot of a *running* domain saves memory state, which libvirt implements via migration — and
migration is unsupported for a domain with a virtiofs device. It fails with a message about
migration rather than about snapshots, which is a confusing place to start debugging.

## File drop

```bash
bun services/vm/filedrop.ts --dir /var/lib/libvirt/images/egirl/zero/share
```

Serves a page at `http://127.0.0.1:3100`. Files land in the share directory, which the guest sees
at `/srv/share` (symlinked to `~/share`).

It runs on the **host**, writing into a directory the guest reads. The alternative — an upload
endpoint inside the VM — would mean exposing the sandbox's own HTTP surface to the network, which
is the opposite of the reason the sandbox exists.

Binding beyond localhost requires a token, and the server refuses to start without one:

```bash
bun services/vm/filedrop.ts --dir <share> --host 0.0.0.0 --token $(openssl rand -hex 16)
```

Uploaded filenames are reduced to a single safe path segment. `../../etc/passwd` becomes `passwd`
inside the share; a name that sanitises to nothing is rejected rather than given a generated one,
because a substituted name is an upload someone believes landed somewhere it did not. Existing
files are never overwritten — `report.pdf` becomes `report (2).pdf`.

## Storage location

VM storage defaults to `/var/lib/libvirt/images/egirl`, overridable with `EGIRL_VM_DIR`.

**Do not move it into `$HOME`.** On AppArmor systems `virt-aa-helper` generates each domain's
profile, and its own profile grants `/var/lib/libvirt/images/** r` while denying most of `/home`.
With the disk in a home directory the helper cannot read it, so it never whitelists it, so the
domain fails to start with "Permission denied" naming a file whose unix permissions are correct.
No amount of `chmod` or `setfacl` fixes it, because the denial is not happening at that layer.

## Teardown

```bash
virsh -c qemu:///system destroy zero
virsh -c qemu:///system undefine zero --remove-all-storage --snapshots-metadata
```

The base cloud image is shared by every instance as a qcow2 backing file, so a second VM costs
only what it writes.
