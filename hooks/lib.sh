#!/usr/bin/env bash
# Shared helpers for the kit's hooks. Sourced, never run. Works on bash 3.2 (macOS) and Git Bash.
# jq is optional: without it, node parses and escapes JSON.

zh_home() { printf '%s' "${ZEKIS_HARNESS_HOME:-$HOME/.zekis-harness}"; }
zh_state() { printf '%s' "${AGENT_KIT_STATE:-$HOME/.agent-handoffs/.state}"; }

# zh_hook_off <name>: succeeds when config.json sets hooks.<name> to false. A missing config means on.
zh_hook_off() {
  local cfg
  cfg="$(zh_home)/config.json"
  [ -f "$cfg" ] && tr -d '\r\n' < "$cfg" | grep -Eq "\"$1\"[[:space:]]*:[[:space:]]*false"
}

# jget <dotted.path>: reads the JSON in $input, prints the value or nothing.
jget() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r ".$1 // empty" 2>/dev/null
  else
    printf '%s' "$input" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{let v=JSON.parse(d);for(const k of process.argv[1].split("."))v=v==null?v:v[k];if(v!=null)console.log(typeof v==="object"?JSON.stringify(v):v)}catch(e){}})' "$1" 2>/dev/null
  fi
}

# jstr <text>: prints text as a JSON string literal.
jstr() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -Rs . 
  else
    printf '%s' "$1" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))'
  fi
}

# with_timeout <seconds> <command...>: uses timeout or gtimeout when present, otherwise runs unbounded.
with_timeout() {
  local secs=$1; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"
  else "$@"; fi
}

# mtime <file>: modification time in epoch seconds, 0 when unreadable.
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
