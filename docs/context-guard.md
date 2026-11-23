# Context guard enforcement

The soft stage is advisory: at 150k input-context tokens, finish the current coherent step and hand off at a natural break. The default hard stage is 200k tokens. `AGENT_KIT_HANDOFF_TOKENS`, `AGENT_KIT_HANDOFF_HARD_TOKENS`, percentage demo mode (`AGENT_KIT_HANDOFF_AT`), the off switch (`AGENT_KIT_AUTO_HANDOFF=0`) and the subagent exclusion are retained.

At the hard stage, `PreToolUse` denies all main-session tools except Claude's `Write` to exactly `<state>/handoffs/<session_id>.md`. The default state directory is `~/.agent-handoffs/.state`; `AGENT_KIT_STATE` overrides it. The handoff subdirectory keeps these documents out of `continue.ps1`'s top-level state-file pruning. The hook prints the absolute target path and required handoff format in its denial reason. A permitted Write still goes through normal Claude permissions: the hook never auto-approves it.

The handoff must be at most 60 lines with populated `## Goal`, `## State` and `## Next step` sections. Include absolute repo and branch information, uncommitted changes, unfinished work and verification gaps. After a successful Write, `PostToolUse` checks the resulting file and returns `continue: false` with a resume command. Empty, missing or incomplete handoffs remain writable, and all other tools remain denied. Symbolic-link targets are not permitted.

**Hard-stage continuation is a controlled pause, not an automatic shell launch.** A human or external coordinator must run the printed `continue.ps1` command from outside the stopped session. There is deliberately no Bash, PowerShell, skill, delegation, browser, arbitrary-file or "cleanup" exemption. Finish cleanup at the soft stage; if the hard stage catches an incomplete edit or running server, record it for the next session. Soft-stage continuation uses the handoff skill and the usual continuation command.

## Registration

With `hooks.contextGuard` set to `true` in `~/.zekis-harness/config.json`, `bin/sync.ps1` wires the hook into Claude Code's settings. If you wire it by hand, merge the following into the appropriate Claude settings file, preserving unrelated hooks and replacing `<kit>` with the absolute path of the kit folder:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "sh <kit>/hooks/context-guard.sh" } ] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "sh <kit>/hooks/context-guard.sh" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "sh <kit>/hooks/context-guard.sh" } ] }
    ]
  }
}
```

Quote the script path inside `command` if it contains spaces. `jq`, `awk` and `realpath` must be available. The status-line integration must keep writing current input + cache read + cache creation tokens to `<state>/<session_id>.tokens`. Percentage mode uses `<session_id>.pct`.

Register `PreToolUse` for all tools, not just Bash. Keeping only `PostToolUse` and `UserPromptSubmit` still permits tools to execute before any reminder. Confirm effective registration in Claude's hook configuration and inspect debug output for dependency errors.

## Supported semantics and limits

The [Claude hook reference](https://code.claude.com/docs/en/hooks#decision-control) documents `PreToolUse`'s `hookSpecificOutput.permissionDecision: "deny"`. The [universal JSON output](https://code.claude.com/docs/en/hooks#json-output) documents `continue: false`, which stops processing after the hook. `PostToolUse` cannot undo a tool that already executed. These are Claude hook fields, not Copilot extension-hook fields; there is no Copilot hard guard.

Denied tools cannot execute, but the model can still generate text or retry denied tools. This is not a token-budget kill switch. An in-flight tool can cross the threshold before the next gate, parallel calls may already be running, and stale or missing status-line state cannot enforce a current limit. Hooks disabled by settings or policy, dependency failures, or unsupported host versions also prevent reliable enforcement. Do not treat a reminder or a successful script exit as proof a live session was blocked.
