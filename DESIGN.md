# Design

## Goal

A kit anyone can install into their coding agents (Claude Code, Codex, Copilot CLI, and any agent that reads Agent Skills) that makes them cheaper and more reliable: one strong model plans and reviews, cheap models do bounded work, sessions hand off before they bloat, and UI work follows fixed rules.

## Nothing personal lives here

- The repo is generic. Facts about one person (names, accounts, browser profiles, paths, employers, schools) never go in a tracked file.
- Per-person data lives outside the repo, in `~/.zekis-harness/`:
  - `config.json`: machine settings (which agents, which hooks, tool paths, browser profiles). Written by `bin/setup.ps1` or the `setup` skill.
  - `profile.md`: free-form facts and preferences skills may read (style overrides, account notes). Never committed anywhere.
- Skills say "the user", not a name, and read `profile.md` when it exists.
- This kit stands alone. It is not a base layer for anyone's private kit, it has no overlay or import mechanism, and nothing copies files between it and another repo. Personal skills live in their own repo with their own install.

### Guard

| Layer | What it checks |
| --- | --- |
| `leak-scan` workflow (required check on `main`) | Every tracked file and every commit message against a private denylist kept in the `LEAK_DENYLIST` Actions secret; author and committer emails must be GitHub noreply addresses; only text file types; gitleaks for secrets. It runs from the base branch (`pull_request_target`), so a pull request cannot weaken its own scan, and it prints file, line and entry number only, never the matched text. |
| `.githooks/pre-push` | The same scan locally before a push (`git config core.hooksPath .githooks`, `LEAK_DENYLIST_FILE=<your denylist>`). |
| GitHub secret scanning with push protection | Known token formats. |

## Install paths

| Path | Gets | For |
| --- | --- | --- |
| Plugin (`.claude-plugin/`) | Skills and hooks | Claude Code, Copilot CLI and Codex plugin installers |
| `bin/setup.ps1` then `bin/sync.ps1` | Skills into every configured agent, the opt-in starter policy, hook wiring, tooling | Anyone who wants the whole kit |
| The `setup` skill | An agent runs the steps above for the user and asks only what it cannot detect | People who want to do nothing by hand |

PowerShell 7 (`pwsh`) runs on Windows, macOS and Linux; hooks are POSIX `sh`/`bash`. Platform-specific pieces branch on `$IsWindows` / `$IsMacOS` / `$IsLinux` and degrade (print the command) when a terminal or tool is missing.

## Starter policy

`policy/starter.md` is the short rulebook the skills assume (git through PRs, delegate by cost, hand off past about 150k tokens, plain writing). It is opt-in: `config.json` `policy.starter: true` makes `sync.ps1` render it between markers in `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and `~/.copilot/copilot-instructions.md`. Text outside the markers is the user's and is never touched. `policy.extra` lists more policy files of the user's own, appended after it.
