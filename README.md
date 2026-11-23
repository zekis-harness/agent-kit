# agent-kit

Skills, a starter policy and tooling that make coding agents cheaper and steadier. Works with Claude Code, Codex and GitHub Copilot CLI, and the skills work in any agent that reads [Agent Skills](https://agentskills.io) (`SKILL.md` folders).

The idea: one strong model plans and reviews, cheap models do bounded work, sessions hand off before they bloat, and UI work follows fixed rules instead of AI defaults.

## Set up (let your agent do it)

Paste this into Claude Code, Codex or Copilot CLI:

```
Set up zekis-harness for me: clone https://github.com/zekis-harness/agent-kit to ~/zekis-harness (or update it if it is already there), then read skills/setup/SKILL.md in it and follow it end to end. Ask me only what you cannot detect.
```

The agent checks for git, Node and PowerShell 7, installs what is missing with your OK, asks up to four questions, installs everything, verifies it, and tells you to restart.

## Other ways to install

**Plugin (skills and hooks only).** Pick one agent:

| Agent | Command |
| --- | --- |
| Claude Code | `/plugin marketplace add zekis-harness/agent-kit` then `/plugin install agent-kit@zekis-harness` |
| Codex | `codex plugin marketplace add zekis-harness/agent-kit` then `codex plugin add agent-kit@zekis-harness` |
| Copilot CLI | `copilot plugin marketplace add zekis-harness/agent-kit` then `copilot plugin install agent-kit@zekis-harness` |

**Full kit by hand** (skills into every agent you have, opt-in starter policy, hooks, tooling):

```
git clone https://github.com/zekis-harness/agent-kit.git ~/zekis-harness
pwsh -NoProfile -File ~/zekis-harness/bin/setup.ps1
```

Use the plugin or the full kit for a given agent, not both, or skills load twice.

Needs: git, Node 22+, PowerShell 7 (`pwsh`, on Windows, macOS and Linux).

## Skills

| Skill | What it does |
| --- | --- |
| `setup` | Installs, updates or removes this kit for you. |
| `delegate` | Picks a model tier for a task, writes the brief for a cheaper worker, and checks its report. |
| `handoff` | Writes the session's state to a file so a fresh session (any agent) continues the work. |
| `backlog-burndown` | Works through a list of issues one PR at a time. |
| `stacked-prs` | Splits a large change into a stack of small dependent PRs. |
| `use-chrome` | Drives your real, signed-in Chrome profiles through Playwright MCP instead of a blank browser. |
| `ui-design` | Visual rules for UI: AI default looks to avoid, a default style, layout, color, motion, mobile. |
| `ui-copy` | What words a UI may carry: labels and data, not explanations. |
| `secure-credentials` | Rules before storing API keys, OAuth tokens or building finance and health integrations. |
| `ship-personal-tool` | Defaults for turning a personal script or page into an app other people use. |

## Your settings

Everything about you stays on your machine in `~/.zekis-harness/`:

- `config.json`: which agents you use, starter policy on or off, which hooks, an optional wrapper for heavy jobs, and browser profiles.
- `profile.md`: facts and preferences skills may read, such as your UI style or which Chrome profile holds which account.

Run `setup.ps1` again to change answers. `bin/sync.ps1 -Check` shows drift; a skill file you edited in place is reported and left alone.

## Tooling

| Path | What |
| --- | --- |
| `bin/setup.ps1` | Writes your config, wires hooks, runs sync. |
| `bin/sync.ps1` | Installs skills into each configured agent and renders the policy between markers. |
| `bin/dispatch.ps1` | Runs one headless worker (Claude, Codex or Copilot) on a brief and prints only its report. |
| `bin/fleet.ps1` | Runs several briefs at once with memory-aware slots and a worktree per writer. |
| `bin/continue.ps1` | Opens a new terminal tab running an agent with a resume prompt. |
| `bin/land.ps1` | Accepts or discards a worker's worktree. |
| `tiers.json` | Model and effort per agent and tier (`chore`, `build`, `plan`). Edit to match your plans. |
| `worker-contract.md` | Appended to every brief: scope rules and the report shape. |
| `hooks/` | `context-guard.sh` (hand off past about 150k tokens), `keep-warm.sh` (keep the cache warm during pauses), `auto-sync.sh` (update at session start). |
| `dash/` | Local dashboard of token use and cost across agents (Bun). |

## Contributing

Pull requests are welcome. Every PR runs a leak scan (no personal data, GitHub noreply commit emails, text files only, no secrets) and tests on Windows, macOS and Linux. See [DESIGN.md](DESIGN.md).

## License

MIT
