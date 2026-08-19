#!/usr/bin/env bash
# Provision a disposable VM running one egirl instance.
#
# The case this exists for is an agent that runs untrusted code -- reverse engineering, unknown
# binaries, anything where the failure mode is not "wrong answer" but "the host is gone". egirl's
# own path_sandbox and command_filter are heuristics inside the process: useful, but the model can
# be argued out of them and a hostile binary ignores them entirely. A VM is an actual boundary.
#
# A container is the wrong tool here even though it is easier. It shares the host kernel, so one
# kernel bug ends the isolation, and "root in the container" is namespaced root -- which conflicts
# with wanting the agent to have real root over its own machine.
#
# What makes this cheap: the operator model runs over HTTP on another host, so the guest needs an
# IP and nothing else. No GPU passthrough, which is the part that usually makes agent VMs painful.
#
# Usage:
#   provision.sh zero --endpoint http://192.168.8.218:8214 \
#                     --persona ~/.egirl/personas/zero --env-file ~/Projects/egirl/.env.zero
#   provision.sh zero --memory 16384 --vcpus 4 --disk 80
#
set -euo pipefail

NAME=""
MEMORY=8192
VCPUS=4
DISK=60
PERSONA=""
ENV_FILE=""
ENDPOINT=""
MODEL="operator"
IMAGE_URL="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
# Under /var/lib/libvirt/images rather than $HOME, and that is not a style preference.
#
# On AppArmor systems `virt-aa-helper` generates each domain's profile, and its own profile grants
# `/var/lib/libvirt/images/** r` while denying most of /home. Put the disk in a home directory and
# the helper cannot read it, so it never whitelists it, so the domain fails to start with a plain
# "Permission denied" naming a file whose unix permissions are fine. No amount of chmod or setfacl
# fixes it, because the denial is not happening at that layer.
VM_DIR="${EGIRL_VM_DIR:-/var/lib/libvirt/images/egirl}"

die() { echo "provision: $*" >&2; exit 1; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

[ $# -gt 0 ] || usage 1
NAME=$1; shift
case "$NAME" in -*) usage 1 ;; esac
# The name becomes a domain name, a directory, a hostname and a guest username. Keep it boring
# rather than discovering later which of those four rejects it.
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "name must be lowercase alphanumeric with dashes"

while [ $# -gt 0 ]; do
  case "$1" in
    --memory)   MEMORY=$2; shift 2 ;;
    --vcpus)    VCPUS=$2; shift 2 ;;
    --disk)     DISK=$2; shift 2 ;;
    --persona)  PERSONA=$2; shift 2 ;;
    --env-file) ENV_FILE=$2; shift 2 ;;
    --endpoint) ENDPOINT=$2; shift 2 ;;
    --model)    MODEL=$2; shift 2 ;;
    --image)    IMAGE_URL=$2; shift 2 ;;
    -h|--help)  usage 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

# --- preflight ---------------------------------------------------------------
# Each of these fails in a confusing way later if it is missing, and the fix for each is one
# command. Checking up front is the difference between "install virtinst" and a half-created
# domain with an unreadable disk.
for tool in virsh virt-install qemu-img genisoimage ssh-keygen curl; do
  command -v "$tool" >/dev/null || die "missing $tool

On Debian/Ubuntu:
  sudo apt install -y qemu-system-x86 libvirt-daemon-system libvirt-clients virtinst \\
                      genisoimage acl
  sudo usermod -aG kvm,libvirt \$USER   # then log out and back in

Note: the package is qemu-system-x86, not qemu-kvm -- the latter is a transitional
package that no longer exists on current releases, and apt will abort the whole
install rather than skip it."
done

[ -e /dev/kvm ] || die "/dev/kvm missing -- enable virtualisation in firmware (AMD-V / VT-x)"
groups | grep -qw libvirt || die "not in the libvirt group; run: sudo usermod -aG libvirt \$USER (then re-login)"
virsh -c qemu:///system list >/dev/null 2>&1 || die "cannot reach qemu:///system -- is libvirtd running?"

virsh -c qemu:///system dominfo "$NAME" >/dev/null 2>&1 && die "domain '$NAME' already exists"

[ -n "$PERSONA" ] && [ ! -d "$PERSONA" ] && die "persona directory not found: $PERSONA"
[ -n "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ] && die "env file not found: $ENV_FILE"

# --- layout ------------------------------------------------------------------
# Checked before creating anything, so an unwritable location produces the one-line fix below
# rather than a raw mkdir error three steps in.
if [ ! -d "$VM_DIR" ] || [ ! -w "$VM_DIR" ]; then
  die "cannot write to $VM_DIR

One-time setup:
  sudo mkdir -p $VM_DIR
  sudo chgrp libvirt $VM_DIR && sudo chmod 2775 $VM_DIR

Set EGIRL_VM_DIR to override the location. Avoid \$HOME: on AppArmor systems virt-aa-helper
cannot read there, so the domain fails to start even when the file permissions look correct."
fi

INSTANCE_DIR="$VM_DIR/$NAME"
SHARE_DIR="$INSTANCE_DIR/share"
mkdir -p "$INSTANCE_DIR" "$SHARE_DIR"

echo "==> base image"
BASE="$VM_DIR/$(basename "$IMAGE_URL")"
if [ ! -f "$BASE" ]; then
  curl -fL --progress-bar -o "$BASE.part" "$IMAGE_URL" && mv "$BASE.part" "$BASE"
else
  echo "    cached: $BASE"
fi

# Note for anyone relocating this: the overlay is a backing-file arrangement, so qemu opens the
# base image as well as the disk. Both must live somewhere the domain profile permits.

echo "==> disk"
# Backing file, so every VM after the first costs only what it writes and the base stays pristine.
qemu-img create -f qcow2 -F qcow2 -b "$BASE" "$INSTANCE_DIR/disk.qcow2" "${DISK}G" >/dev/null

echo "==> access key"
KEY="$INSTANCE_DIR/id_ed25519"
[ -f "$KEY" ] || ssh-keygen -t ed25519 -f "$KEY" -N "" -C "egirl-vm-$NAME" -q
# ssh refuses a key any other account can read, reporting it as an authentication failure rather
# than a permissions one -- so this is set explicitly rather than left to the directory's mode.
chmod 600 "$KEY"

echo "==> cloud-init"
SEED_DIR=$(mktemp -d)
trap 'rm -rf "$SEED_DIR"' EXIT

{
  echo "#cloud-config"
  echo "hostname: $NAME"
  echo "manage_etc_hosts: true"
  echo "users:"
  echo "  - name: $NAME"
  echo "    shell: /bin/bash"
  echo "    groups: [sudo]"
  echo "    sudo: [\"ALL=(ALL) NOPASSWD:ALL\"]"
  echo "    lock_passwd: false"
  echo "    ssh_authorized_keys: [\"$(cat "$KEY.pub")\"]"
  # Real root in the guest is the point: the boundary is the VM, not the account. A password is
  # set so the serial console still works when the agent breaks networking, which it will.
  echo "chpasswd: {expire: false, list: \"$NAME:$NAME\\nroot:$NAME\"}"
  echo "package_update: true"
  echo "packages: [curl, git, unzip, build-essential, python3-pip, file, binutils, xxd, jq]"
  # Mounted at /srv/share rather than inside the home directory, and reached by a symlink.
  #
  # systemd creates a mountpoint's parent if it is missing, and it does that before cloud-init
  # creates the user. Mounting straight to /home/<name>/share therefore produces a root-owned
  # /home/<name>, and the account cannot write to its own home -- which surfaces much later as an
  # unrelated-looking "Permission denied" the first time anything writes there.
  echo "mounts:"
  echo "  - [share, /srv/share, virtiofs, \"defaults,nofail\", \"0\", \"0\"]"
  echo "runcmd:"
  echo "  - [bash, -lc, \"chown $NAME:$NAME /home/$NAME\"]"
  echo "  - [bash, -lc, \"ln -sfn /srv/share /home/$NAME/share && chown -h $NAME:$NAME /home/$NAME/share\"]"
  echo "  - [bash, -lc, \"curl -fsSL https://bun.sh/install | sudo -u $NAME bash\"]"
  echo "  - [bash, -lc, \"sudo -u $NAME git clone --depth 1 https://github.com/Schneewolf-Labs/egirl.git /home/$NAME/egirl\"]"
  echo "  - [bash, -lc, \"cd /home/$NAME/egirl && sudo -u $NAME /home/$NAME/.bun/bin/bun install --no-save || true\"]"
} > "$SEED_DIR/user-data"

printf 'instance-id: %s\nlocal-hostname: %s\n' "$NAME" "$NAME" > "$SEED_DIR/meta-data"
genisoimage -output "$INSTANCE_DIR/seed.iso" -volid cidata -joliet -rock \
  "$SEED_DIR/user-data" "$SEED_DIR/meta-data" >/dev/null 2>&1

echo "==> creating domain"
# virtiofs needs shared memory backing; without it the filesystem device fails at start with a
# message that does not mention memory.
virt-install --connect qemu:///system --name "$NAME" \
  --memory "$MEMORY" --vcpus "$VCPUS" --cpu host-passthrough \
  --memorybacking access.mode=shared \
  --disk "path=$INSTANCE_DIR/disk.qcow2,format=qcow2,bus=virtio" \
  --disk "path=$INSTANCE_DIR/seed.iso,device=cdrom" \
  --filesystem "type=mount,accessmode=passthrough,driver.type=virtiofs,source=$SHARE_DIR,target=share" \
  --os-variant ubuntu24.04 --network network=default,model=virtio \
  --graphics none --console pty,target_type=serial --import --noautoconsole >/dev/null

echo "==> waiting for an address"
IP=""
for _ in $(seq 60); do
  IP=$(virsh -c qemu:///system domifaddr "$NAME" 2>/dev/null | awk '/ipv4/{print $4}' | cut -d/ -f1 | head -1)
  [ -n "$IP" ] && break
  sleep 5
done
[ -n "$IP" ] || die "no address after 5 minutes; check: virsh console $NAME"

echo "==> waiting for cloud-init (installing packages, bun, egirl)"
# The status string is parsed rather than `cloud-init status --wait` being trusted for its exit
# code. `--wait` exits 2 on "degraded done" -- finished, but some module returned non-zero -- and
# a loop keyed on the exit code spins until its timeout on a guest that is actually ready.
# Degraded is normal here: an apt mirror hiccup or a runcmd exiting non-zero is enough.
CI_STATE=""
for _ in $(seq 120); do
  CI_STATE=$(ssh -i "$KEY" -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=5 \
      "$NAME@$IP" "cloud-init status 2>/dev/null | head -1" 2>/dev/null || true)
  case "$CI_STATE" in
    *done*|*error*) break ;;
  esac
  sleep 10
done
case "$CI_STATE" in
  *error*) echo "    cloud-init reported errors; continuing -- check: cloud-init status --long" ;;
  *done*)  : ;;
  *)       die "cloud-init did not finish; check: virsh -c qemu:///system console $NAME" ;;
esac

if [ -n "$PERSONA" ]; then
  echo "==> copying persona"
  ssh -i "$KEY" -o StrictHostKeyChecking=no -o BatchMode=yes "$NAME@$IP" "mkdir -p ~/.egirl/personas/$NAME"
  scp -i "$KEY" -o StrictHostKeyChecking=no -q "$PERSONA"/*.md "$NAME@$IP:~/.egirl/personas/$NAME/"
fi

if [ -n "$ENDPOINT" ]; then
  echo "==> writing guest config"
  # The repo ships an egirl.toml pointing at localhost:8080. Inside the VM nothing is listening
  # there, so without this the agent starts and every turn fails to reach a model. The workspace
  # is aimed at the persona directory too, or the copied personality files are never read.
  GUEST_TOML=$(mktemp)
  cat > "$GUEST_TOML" <<TOML
# Generated by services/vm/provision.sh -- edit freely, it is not regenerated.
theme = "neon"

[thinking]
level = "off"

[workspace]
path = "~/.egirl/personas/$NAME"

[local]
endpoint = "$ENDPOINT"
model = "$MODEL"
context_length = 32768
max_concurrent = 1
tool_format = "auto"
stale_stream_timeout_ms = 300000

[channels.api]
host = "0.0.0.0"
port = 3000

[safety]
enabled = true

[safety.command_filter]
enabled = true

[safety.audit_log]
enabled = true
path = "{workspace}/audit.log"

[tools]
code_agent = false
tasks = false
TOML
  scp -i "$KEY" -o StrictHostKeyChecking=no -q "$GUEST_TOML" "$NAME@$IP:~/egirl/egirl.toml"
  rm -f "$GUEST_TOML"
fi

if [ -n "$ENV_FILE" ]; then
  echo "==> copying env"
  scp -i "$KEY" -o StrictHostKeyChecking=no -q "$ENV_FILE" "$NAME@$IP:~/egirl/.env"
  ssh -i "$KEY" -o StrictHostKeyChecking=no -o BatchMode=yes "$NAME@$IP" "chmod 600 ~/egirl/.env"
fi

cat <<EOF

  domain    $NAME
  address   $IP
  ssh       ssh -i $KEY $NAME@$IP
  chat      ssh -i $KEY -t $NAME@$IP 'cd egirl && ~/.bun/bin/bun run start cli'
  console   virsh -c qemu:///system console $NAME
  share     $SHARE_DIR  ->  /home/$NAME/share  (host writes, guest reads)

Snapshot before the first real run -- reverting is what makes the VM disposable, and disposable
is what lets the agent work on something hostile without it mattering.

The guest must be shut off first. A running snapshot saves memory state, which libvirt implements
via migration, and migration is not supported for a domain with a virtiofs device -- it fails with
a message about migration rather than about snapshots.

  snapshot  virsh -c qemu:///system shutdown $NAME     # wait for shutoff
            virsh -c qemu:///system snapshot-create-as $NAME clean
            virsh -c qemu:///system start $NAME

  revert    virsh -c qemu:///system destroy $NAME
            virsh -c qemu:///system snapshot-revert $NAME clean
            virsh -c qemu:///system start $NAME

  destroy   virsh -c qemu:///system destroy $NAME
            virsh -c qemu:///system undefine $NAME --remove-all-storage --snapshots-metadata
EOF
