#!/usr/bin/env bash
# Claude Code hook (SessionStart). When the kit clone's upstream branch has commits the clone lacks,
# fast-forwards it and runs bin/sync.ps1. The clone is `kit` in ~/.zekis-harness/config.json
# (default: this script's repo). Checks the remote at most every AGENT_KIT_SYNC_EVERY seconds (600).
# Skips a dirty clone or a branch without an upstream. AGENT_KIT_AUTO_SYNC=0 or hooks.autoSync=false
# in config.json disables.
[ "${AGENT_KIT_AUTO_SYNC:-1}" = 0 ] && exit 0
. "$(dirname "$0")/lib.sh"
zh_hook_off autoSync && exit 0
cat >/dev/null
kit="$AGENT_KIT_DIR"
if [ -z "$kit" ] && [ -f "$(zh_home)/config.json" ]; then
  input=$(cat "$(zh_home)/config.json")
  kit=$(jget kit)
fi
[ -n "$kit" ] && [ -d "$kit" ] || kit=$(cd "$(dirname "$0")/.." && pwd)
state=$(zh_state)
mkdir -p "$state" || exit 0
stamp="$state/auto-sync.last"
now=$(date +%s)
last=$(cat "$stamp" 2>/dev/null || echo 0)
[ $((now - last)) -ge "${AGENT_KIT_SYNC_EVERY:-600}" ] 2>/dev/null || exit 0
lock="$state/auto-sync.lock"
mkdir "$lock" 2>/dev/null || exit 0
trap 'rmdir "$lock"' EXIT
printf '%s' "$now" > "$stamp"

g() { git -C "$kit" "$@"; }
g rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 || exit 0
[ -z "$(g status --porcelain 2>/dev/null)" ] || exit 0
GIT_TERMINAL_PROMPT=0 with_timeout 15 git -C "$kit" fetch -q 2>/dev/null || exit 0
before=$(g rev-parse HEAD)
[ "$before" != "$(g rev-parse '@{u}')" ] || exit 0
g merge -q --ff-only '@{u}' 2>/dev/null || exit 0

log=$(g log --oneline --no-decorate "$before..HEAD" | head -5)
if pwsh -NoProfile -File "$kit/bin/sync.ps1" >/dev/null 2>&1; then
  msg="agent kit updated and synced (takes effect next session):"
else
  msg="agent kit pulled, but bin/sync.ps1 failed. Run it by hand:"
fi
printf '{"systemMessage":%s}\n' "$(jstr "$msg
$log")"
