#!/usr/bin/env bash
# Claude Code hook (PostToolUse, UserPromptSubmit; PreToolUse optional). Reads the context size the
# status line last recorded in <state>/<session_id>.tokens. Past the soft token threshold it asks for
# a handoff at the next natural break. At the hard threshold, only a session-specific handoff Write
# may execute; after that Write succeeds, stop. Hard-limit enforcement of other tools needs the
# PreToolUse registration. AGENT_KIT_HANDOFF_AT=<percent> switches to the percentage trigger (demos).
# AGENT_KIT_AUTO_HANDOFF=0 or hooks.contextGuard=false in ~/.zekis-harness/config.json disables.
[ "${AGENT_KIT_AUTO_HANDOFF:-1}" = 0 ] && exit 0
. "$(dirname "$0")/lib.sh"
zh_hook_off contextGuard && exit 0
input=$(cat)
# Fast path without a JSON parser: this runs after every tool call.
[[ $input =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] || exit 0
sid=${BASH_REMATCH[1]}
[[ $sid =~ ^[a-zA-Z0-9_-]+$ ]] || { echo "Invalid context-guard session id." >&2; exit 2; }
state=$(zh_state)

if [ -n "$AGENT_KIT_HANDOFF_AT" ]; then
  [ -f "$state/$sid.pct" ] || exit 0
  read -r level < "$state/$sid.pct" || [ -n "$level" ] || exit 0
  soft=$AGENT_KIT_HANDOFF_AT; hard=$AGENT_KIT_HANDOFF_AT; step=10; unit=%
else
  [ -f "$state/$sid.tokens" ] || exit 0
  read -r level < "$state/$sid.tokens" || [ -n "$level" ] || exit 0
  soft=${AGENT_KIT_HANDOFF_TOKENS:-150000}
  [[ $soft =~ ^[0-9]+$ ]] || { echo "Invalid context-guard soft threshold." >&2; exit 2; }
  hard=${AGENT_KIT_HANDOFF_HARD_TOKENS:-$((10#$soft + 50000))}
  step=50000; unit=" tokens"
fi
for number in "$level" "$soft" "$hard"; do
  [[ $number =~ ^[0-9]+$ ]] || { echo "Invalid context-guard threshold or state." >&2; exit 2; }
done
level=$((10#$level)); soft=$((10#$soft)); hard=$((10#$hard))
[ "$hard" -ge "$soft" ] || { echo "Context-guard hard threshold is below soft threshold." >&2; exit 2; }
[ "$level" -ge "$soft" ] 2>/dev/null || exit 0

[ -n "$(jget agent_id)" ] && exit 0
event=$(jget hook_event_name)
[ -n "$event" ] || event=PostToolUse
cwd=$(jget cwd)
kit=$(cd "$(dirname "$0")/.." && { pwd -W 2>/dev/null || pwd; })

# Absolute form of a path whose parent folder exists; other paths come back unchanged.
absolute_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -am "$1"; return; fi
  local dir
  dir=$(cd "$(dirname "$1")" 2>/dev/null && pwd -P) || { printf '%s' "$1"; return; }
  printf '%s/%s' "${dir%/}" "$(basename "$1")"
}
ps_quote() { local value=${1//\'/\'\'}; printf "'%s'" "$value"; }

if [ "$level" -ge "$hard" ]; then
  # continue.ps1 prunes old state files, but not subdirectories containing durable handoffs.
  handoff_dir="$state/handoffs"
  [ ! -L "$handoff_dir" ] || { echo "Context-guard handoff directory is a symlink." >&2; exit 2; }
  mkdir -p "$handoff_dir" || exit 2
  # Resolve neither a pre-existing handoff symlink nor a tool-supplied symlink into an exception.
  handoff_link=false
  [ ! -L "$handoff_dir/$sid.md" ] || handoff_link=true
  handoff=$(absolute_path "$handoff_dir/$sid.md") || exit 2
  target=$(jget tool_input.file_path)
  tool=$(jget tool_name)
  handoff_write=false
  if [ "$tool" = Write ] && [ -n "$target" ] && ! "$handoff_link" && [ ! -L "$target" ]; then
    [ "$(absolute_path "$target")" != "$handoff" ] || handoff_write=true
  fi
  msg="Context is at ${level}${unit}. Hand off now. The hard limit blocks all tools except Write to exactly:
${handoff}
Write a concise Markdown handoff (at most 60 lines) with headings '## Goal', '## State' and '## Next step'. Include the repo, branch, uncommitted changes, unfinished work and verification gaps. Do not repair files, run shell commands, delegate or continue the task. After this file is written, the hook stops this session. A human or external coordinator must launch the fresh session."

  if [ "$event" = PreToolUse ]; then
    if "$handoff_write"; then exit 0; fi # Preserve normal permissions, never auto-approve.
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' "$(jstr "$msg")"
    exit 0
  fi
  if [ "$event" = PostToolUse ] && "$handoff_write"; then
    if [ -s "$handoff" ] && awk '
      { sub(/\r$/, "") }
      /^## / { section=$0; next }
      NF && section=="## Goal" { goal=1 }
      NF && section=="## State" { state=1 }
      NF && section=="## Next step" { nextstep=1 }
      END { exit !(NR<=60 && goal && state && nextstep) }
    ' "$handoff"; then
      resume="pwsh -NoProfile -File $(ps_quote "$kit/bin/continue.ps1") -Handoff $(ps_quote "$handoff") -Cwd $(ps_quote "$cwd") -Harness claude"
      printf '{"continue":false,"stopReason":%s}\n' "$(jstr "Hard context limit: handoff saved at ${handoff}. Resume in a fresh session: ${resume}")"
    else
      printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":%s}}\n' "$(jstr "Handoff is incomplete. Rewrite ${handoff} with headings ## Goal, ## State and ## Next step, at most 60 lines. All other tools remain blocked.")"
    fi
    exit 0
  fi
elif [ "$event" = PreToolUse ]; then
  exit 0
fi

last=$(cat "$state/$sid.warned" 2>/dev/null || echo 0)
[[ $last =~ ^[0-9]+$ ]] || last=0
last=$((10#$last))
if [ "$level" -ge "$hard" ]; then
  [ "$last" -lt "$hard" ] 2>/dev/null || [ "$level" -ge $((last + step)) ] || exit 0
  stage=hard
else
  [ "$last" = 0 ] || exit 0
  stage=soft
fi

printf '%s' "$level" > "$state/$sid.warned"

if [ "$stage" = soft ]; then
  msg="Context is at ${level}${unit}. Hand off at the next natural break (commit, passing test, finished subtask), not mid-step. If the user's whole request will be done by then, finish instead. At the break:
1. Leave no half-edited file and no running server you started.
2. Run the handoff skill.
3. Run: pwsh -NoProfile -File $(ps_quote "$kit/bin/continue.ps1") -Handoff <handoff path> -Cwd $(ps_quote "$cwd")
   It opens a new terminal tab with a fresh session that reads the handoff and continues.
   Add -Model sonnet when the next step is a browser errand or well-specified edits.
4. Close browser tabs you opened, reply with one line naming the handoff path, and do no further work in this session."
fi

printf '{"hookSpecificOutput":{"hookEventName":%s,"additionalContext":%s}}\n' "$(jstr "$event")" "$(jstr "$msg")"
