# Tiers and plans

`tiers.json` maps each harness (`claude`, `codex`, `copilot`) and tier (`chore`, `build`, `plan`) to a model and a reasoning effort. `bin/dispatch.ps1`, `bin/fleet.ps1` and `bin/batch.ps1` read it; `bin/probe.ps1` checks that every entry is still accepted by its CLI.

The shipped table is a default, not a promise: model names change and each plan unlocks a different set. Edit `tiers.json` in your clone to match what your subscriptions offer, then run `pwsh -NoProfile -File bin/probe.ps1` (a few cents per probe) after any plan or CLI upgrade.

| Tier | Use for |
| --- | --- |
| `chore` | Mechanical, bounded work: renames, search, formatting, summaries |
| `build` | Implementation with a clear brief and a narrow check |
| `plan` | Design, review, hard debugging |

Only harnesses you have installed need to work. Dispatching to a harness whose CLI is missing fails with a message naming that CLI and does not affect the others. Remove a harness block from `tiers.json` if you never use it, so `probe.ps1` skips it.

Per-run state: each dispatch appends one JSON line (tokens, cost, duration, status) to `~/.agent-handoffs/ledger.jsonl`; set `AGENT_KIT_LEDGER` to use another file. `bin/verdict.ps1` records whether a worker's output was accepted and `bin/report.ps1` turns the ledger into cost per accepted task.
