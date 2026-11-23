---
name: setup
description: Install, update, or reconfigure the zekis-harness agent kit for the user, end to end, asking only what cannot be detected. Use when the user asks to set up, install, update, repair or uninstall zekis-harness or its agent-kit, or pastes the setup prompt from its README.
---

# Set up zekis-harness for the user

You do every step. The user should only answer a few questions and restart their agent at the end. Explain each question in one plain sentence; never ask them to run a command you can run yourself.

## 1. Check the machine

Detect, do not ask:

- OS (`$IsWindows`/`uname`), shell, and which agents are installed: `claude`, `codex`, `copilot` on PATH. The one you are running in counts.
- `git`, `node` (22 or newer), `pwsh` (PowerShell 7). Windows PowerShell 5 (`powershell.exe`) is not enough.

If something is missing, say what and why in one line each, then offer to install it. On yes:

| Tool | Windows | macOS | Linux (Debian/Ubuntu) |
| --- | --- | --- | --- |
| git | `winget install --id Git.Git -e` | `xcode-select --install` or `brew install git` | `sudo apt-get install -y git` |
| node | `winget install --id OpenJS.NodeJS.LTS -e` | `brew install node` | use the NodeSource or distro package |
| pwsh | `winget install --id Microsoft.PowerShell -e` | `brew install --cask powershell` | see learn.microsoft.com "Install PowerShell on Linux" |

After an install, open a new shell or use the full path so the new tool is found. `sudo` prompts and installer windows are the user's to approve; tell them what to expect.

## 2. Get the kit

- Target folder: `~/zekis-harness`. If it exists and is a clone of `zekis-harness/agent-kit`, `git -C ~/zekis-harness pull --ff-only`. If it exists and is something else, ask before touching it.
- Otherwise `git clone https://github.com/zekis-harness/agent-kit.git ~/zekis-harness`.

## 3. Ask (only these, all at once, with your recommendation)

1. **Starter policy** (recommended yes): installs a short rulebook into each agent's global instructions (work on branches and through pull requests, delegate bounded work to cheaper models, hand off long sessions, plain writing). Their own instructions stay untouched; it lives between markers and can be removed.
2. **Hooks for Claude Code** (recommended yes, only if `claude` is installed): `contextGuard` reminds a long session to hand off, `keepWarm` keeps the prompt cache warm during short pauses, `autoSync` updates the kit at session start.
3. **Browser** (recommended later): whether they want agents to use their real signed-in Chrome now. If yes, follow the "Set up" section of the `use-chrome` skill in `~/zekis-harness/skills/use-chrome/SKILL.md` after step 5.
4. **About you** (optional): a name to be called and any UI style they like. This goes only into `~/.zekis-harness/profile.md` on this machine.

Skip a question the user already answered in their request.

## 4. Install

Run, with the answers:

```
pwsh -NoProfile -File ~/zekis-harness/bin/setup.ps1 -Yes -Harnesses <detected, comma separated> -StarterPolicy:$<true|false> -Hooks <chosen, comma separated> -WireHooks
```

Use `-NoHooks` instead of `-Hooks ... -WireHooks` when they said no. Setup writes `~/.zekis-harness/config.json`, a `profile.md` template, wires the chosen hooks into `~/.claude/settings.json` (existing hooks kept, a `.bak` saved), and runs `bin/sync.ps1`, which copies the skills into each agent and renders the policy.

If setup prints statusline instructions for the context guard, do them for the user: they edit `~/.claude/statusline-command.sh` (create it if absent) and the `statusLine` entry in `~/.claude/settings.json`. Show the diff before saving.

Fill `profile.md` with what they told you in question 4. Leave sections they skipped empty.

Use either this sync install or the plugin (`/plugin install agent-kit --marketplace zekis-harness/agent-kit`), not both, or each skill appears twice.

## 5. Verify

- `pwsh -NoProfile -File ~/zekis-harness/bin/sync.ps1 -Check` reports no drift.
- The skill folders exist for each configured agent (`~/.claude/skills/delegate/SKILL.md` and so on).
- If the starter policy is on, the marker block is present in each agent's global instructions file.
- If hooks were wired, `~/.claude/settings.json` parses as JSON and lists them.

## 6. Finish

Tell the user, in a few lines: what was installed and where, that they must restart their agent (close and reopen it) to load the skills, and three things to try:

- "Use the delegate skill to plan this task" on any medium task.
- "Hand off" when a session gets long.
- "Use the ui-design skill" before building any page.

## Update, change answers, uninstall

- Update: `git -C ~/zekis-harness pull --ff-only` then `sync.ps1` (the `autoSync` hook does this by itself).
- Change answers: run step 3 and 4 again; setup overwrites the config.
- Uninstall: `pwsh -NoProfile -File ~/zekis-harness/bin/setup.ps1 -StarterPolicy:$false -NoHooks -Yes`, then remove the kit's skill folders listed in each `.agent-kit-skills.json`, then delete `~/zekis-harness` and `~/.zekis-harness`. Confirm before deleting.
