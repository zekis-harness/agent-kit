---
name: delegate
description: Choose a model tier and harness for a task, brief a worker, and read its report. Use at the start of any browser errand or multi-layer task, and before handing any implementation, search, or chore to another agent, including Claude Code subagents.
---

# Delegate

`<kit>` is the `kit` path in `~/.zekis-harness/config.json` (default `~/zekis-harness`). Every harness (claude, codex, copilot) is optional: use only those in `harnesses` there.

You are the orchestrator. You plan, decide, review, and verify. Workers implement bounded tasks on cheaper models and return a short report.

## Route first

Orchestration has a fixed cost (brief, wait, verify). Benchmark (Copilot, 40 trials, all accepted): it saved 36% on a medium feature but 3% on a small one, and added about 3 minutes.

- Browser errand or loop over about 10 page actions (applications, forms, scraping, outreach): run it on Sonnet with a brief giving URLs, data, and stop conditions. Every snapshot is reread on every later turn, so long browser sessions on the strongest model dominate spend. The strongest-model session keeps sign-ins, CAPTCHAs, and judgment calls, and reads the report.
- Small and well specified (one brief would cover it, a few files): no workers. Do it in one session; a fresh Sol session costs about 40-50% of Opus at equal quality.
- Medium or larger and well specified (several layers, over 10k tokens of reading): orchestrate, `build` workers on Sol.
- Vague, design-heavy, or debugging: keep it on the strongest model; settle the design before delegating anything.
- Never make Sol the orchestrator: it ran 3x the calls, 2x the workers, and cost more than Opus orchestrating.
- Pick model and effort at session start; switching mid-session rebuilds the whole cache.

## When

- Delegate: a well-specified change with known files and a test that proves it; bulk mechanical edits; broad search or reading whose conclusion you need, not the files.
- Keep: decisions, design, anything you can't brief in under 40 lines, tightly coupled edits, one-file reads, single test runs.
- Parallel workers need non-overlapping files. Coupled edits stay serial.

## Delegate or keep

Sonnet 5.5 is about 0.5x Opus 5.5 list price, not 0.1x. A cold worker reads context at the cache-write rate ($2.50/MTok); a warm orchestrator rereads what it holds at 0.05x ($0.20). The real saving is keeping exploration out of the orchestrator, where every token is reread on every later turn.

Delegate when any holds:
- Exploration or reading the orchestrator has not done, roughly over 10k tokens.
- Large output: many edits, generated tests, bulk changes.
- It can run in parallel with other work (non-overlapping files).

Keep when the orchestrator already holds the files and the edit is small, or the brief would be longer than the change.

Claude subagents and `dispatch.ps1 -Harness claude` share one quota and both get the 5m TTL; use `dispatch` for its report contract or another harness's quota.

## Tiers

| Tier | Use for | claude | codex | copilot |
| --- | --- | --- | --- | --- |
| `chore` | read-only search, summaries, renames, formatting, precisely specified edits | haiku | gpt-5.6-terra | gpt-6-luna |
| `build` | default worker: a scoped feature, bug fix, or test with clear acceptance | sonnet | gpt-5.6-sol | gpt-6.1-sol |
| `plan` | design, hard debugging, review of a risky diff | opus | gpt-5.6-sol, high | claude-opus-5.5 |

Exact IDs and efforts live in `<kit>/tiers.json`. Never pick `max` effort or a premium model (fable, gpt-6-astra) yourself. Haiku and luna only get precisely specified work.

Harness choice is about which subscription has headroom, not capability. Spread bulk work across subscriptions so no single one hits its limit.

## Brief

The worker sees nothing of this conversation. Write the brief to a file in `~/.agent-handoffs/tasks/`:

```markdown
# Task: <one line>
Repo: <absolute path>   Branch: <name, already checked out>
## Goal
<what and why, 2-5 lines>
## Scope
Touch only: <files/dirs>. Do not touch: <files>.
## Decided
<choices already made; the worker must not revisit them>
## Acceptance
- <observable behavior>
- Test: `<exact command>` passes
Expected size: <about N files, about N lines>
```

Quote exact errors and code, not your summary of them. Paste exact paths with line ranges and the snippets the worker needs, so it does not rediscover them. `Expected size` tells it when to stop and report.

## Run

- Claude Code, same subscription: Agent tool with `model: "sonnet"` or `"haiku"` and the brief as the prompt.
- Any harness, any subscription:
  `pwsh -NoProfile -File <kit>/bin/dispatch.ps1 -Brief <file> -Harness <claude|codex|copilot> -Tier <chore|build|plan> [-Mode read|safe|bypass] [-Worktree] [-TimeoutMinutes 30]`
  It prints only the worker's final report and a `run=<id>` footer with cost. The full transcript is in `<brief>.log`; open it only if the report is unclear.
- Default `-Mode safe` allows edits and shell with a no-prompt safety review and no `git push`. Use `read` for search and summaries.
- Parallel workers: add `-Worktree`. Each gets its own branch and checkout; land or drop it with `<kit>/bin/land.ps1 -Worktree <path> -Accept|-Discard`.
- Two or more independent briefs, in one repo or several: run them together instead of opening more sessions.
  `pwsh -NoProfile -File <kit>/bin/fleet.ps1 -Brief <a.md>,<b.md>,<glob> [-Harness ..] [-Tier ..] [-MaxConcurrent 4] [-DryRun]`
  Each brief's `Repo:` line picks its repository; optional `Harness:`, `Tier:` and `Mode:` lines in a brief override the flags for that worker. Write-mode workers get a worktree each. Workers start as free memory allows (a headless worker measured about 250 MB against 750 MB to 1 GB for an interactive session), so a queue on a full machine waits instead of thrashing. It prints one line per finished worker and a table with each `run=<id>`; read each `<brief>.report.md`, verify, record a verdict, then land or discard each worktree.

## Watch running workers

A background worker can stall silently (a browser tool retry loop, a stale tab, a wrong selector) and the orchestrator never hears about it, because it only wakes on the completion notice.

- When you launch a worker, name its expected time (one application form or one browser errand: about 6 minutes; a scoped code change: about 15).
- Before ending your turn, arm a wake-up at that mark: a background Bash `sleep <seconds>` (`run_in_background: true`) or a Monitor timer. Never end a turn with a worker running and nothing scheduled to wake you.
- At the mark, if it has not reported, ask it with SendMessage for the step it is on, what blocks it, and its next action. Re-arm a shorter wake-up (about 3 minutes).
- If the answer shows no progress since the last check, or the same action retried more than twice, stop it (TaskStop) and do the step yourself or re-brief with the exact blocker. Tell the user what stalled.
- Put the time budget in the brief too: "If one step takes over 3 minutes or 3 tries, stop and report STATUS: blocked with the exact error."

## Read the report

- A report is a claim. Check `git diff --stat` and the cited test yourself before relaying it.
- Then record the outcome: `<kit>/bin/verdict.ps1 -Run <id> -Outcome accepted|rework|escalated|discarded`. `<kit>/bin/report.ps1` turns these into cost per accepted task per tier.
- `STATUS: blocked`: answer the question in the brief and re-run, or do it yourself.
- Two failed attempts at a tier: do it yourself or re-run one tier up. Don't retry the same brief a third time.
