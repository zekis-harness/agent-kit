#!/usr/bin/env bash
# Claude Code hook (Stop, asyncRewake, timeout above the interval). Holds an idle session's prompt
# cache: after each turn it sleeps just under the 1h TTL, then exits 2, which wakes Claude for a
# one-word reply that reads and so refreshes the cache. A newer turn cancels the older sleeper.
# Stops after AGENT_KIT_KEEPWARM_MAX pings without a real turn, and skips sessions under
# AGENT_KIT_KEEPWARM_MIN_TOKENS, whose rebuild is cheap. AGENT_KIT_KEEPWARM=0 or
# hooks.keepWarm=false in ~/.zekis-harness/config.json disables.
[ "${AGENT_KIT_KEEPWARM:-1}" = 0 ] && exit 0
. "$(dirname "$0")/lib.sh"
zh_hook_off keepWarm && exit 0
input=$(cat)
[[ $input =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] || exit 0
sid=${BASH_REMATCH[1]}
[[ $sid =~ ^[a-zA-Z0-9_-]+$ ]] || exit 0
state=$(zh_state)
interval=${AGENT_KIT_KEEPWARM_SECONDS:-3000}
max=${AGENT_KIT_KEEPWARM_MAX:-3}
min=${AGENT_KIT_KEEPWARM_MIN_TOKENS:-60000}

[ -f "$state/$sid.tokens" ] || exit 0
read -r tokens < "$state/$sid.tokens" || [ -n "$tokens" ] || exit 0
[ "$tokens" -ge "$min" ] 2>/dev/null || exit 0

fired="$state/$sid.kw-fired"
pings=0
if [ -f "$fired" ]; then
  pings=$(( $(cat "$fired") ))
  rm -f "$fired"
fi
[ "$pings" -lt "$max" ] || exit 0

arm="$state/$sid.kw-arm"
stamp="$(date +%s).$$"
printf '%s' "$stamp" > "$arm"
sleep "$interval"
[ "$(cat "$arm" 2>/dev/null)" = "$stamp" ] || exit 0

# A prompt still running has no Stop yet, so it shows only as recent transcript writes.
if [[ $input =~ \"transcript_path\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  transcript=${BASH_REMATCH[1]//\\/\/}
  written=$(mtime "$transcript")
  [ "$written" -le $(( ${stamp%%.*} + 60 )) ] || exit 0
fi

printf '%s' "$((pings + 1))" > "$fired"
echo "[keep-warm] Idle cache heartbeat, nothing to do. Reply with only: ok" >&2
exit 2
