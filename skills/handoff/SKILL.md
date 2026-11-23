---
name: handoff
description: Write the current session's state to a Markdown file so a fresh session, possibly in a different agent CLI, can continue the work. Use at a task boundary once context passes about 150k tokens, before switching harness or model, when returning to a session whose cache has expired, or when the user says handoff.
---

Write a handoff so a fresh session can continue without this conversation.

## When

A handoff is not free: the new session re-reads code and repeats work. Benchmark: handing off mid-way through a medium feature (60-85k tokens of context) cost 34% more than finishing in one session ($2.00 vs $1.49, same quality).

- Hand off at a task boundary (card, PR, or subtask done), not mid-step and not by percentage.
- Do it once context passes about 150k tokens and real work remains; every turn rereads the whole context.
- Do it instead of paying a rebuild: when you return after the cache expired (Claude main sessions 1 hour, Claude subagents 5 minutes, Sol 30), a 150k+ context costs more to rebuild than a fresh session costs to start.
- Before switching model or harness, since a switch rebuilds the cache anyway.
- Below about 100k tokens, finish in place.

## Where

`~/.agent-handoffs/<repo-or-topic>-<YYYYMMDD-HHMM>.md` unless the user gave a path. Never inside the checkout.

## What

Only what the next session can't cheaply rediscover:

- **Goal**: what the user wants, plus constraints and preferences they stated.
- **State**: done, in progress, left. Repo, branch, uncommitted work, PR/issue numbers, key files (absolute paths).
- **Decisions**: what was chosen, why, what was ruled out.
- **Open questions**: unresolved items and blockers.
- **Next step**: the first concrete action.

Mark what was verified vs. assumed. Point to docs, diffs, commits, and issues instead of copying them. Keep it under 60 lines.

## Then

If the context guard fired or the user asked for auto-continue, launch the next session and stop:

```
pwsh -NoProfile -File <kit>/bin/continue.ps1 -Handoff <absolute path> -Cwd <repo> [-Harness claude|codex|copilot] [-Model sonnet]
```

`<kit>` is `kit` in `~/.zekis-harness/config.json` (default `~/zekis-harness`).

It opens a new terminal tab whose fresh session reads the handoff. Do no further work in this session.

Once the new claude session's transcript appears, it closes this session and its tab after about 20 seconds, which frees the old session's memory. Before running it:

- Stop your Monitors and background Bash commands. While any runs, continue.ps1 keeps the old tab open and says why.
- Let running subagents (Agent tool workers) finish first, or stop them and list each one's brief and output file in the handoff so the new session re-dispatches it. They run inside this session and die with it, and continue.ps1 cannot see them, so it closes the tab anyway.
- Move long jobs that must outlive this tab (training, experiment chains) into their own console first, for example `Start-Process pwsh -WindowStyle Hidden -ArgumentList '-NoProfile','-File',<script>`. Closing a tab kills everything attached to its console, including `run_in_background` jobs. Record in the handoff where those jobs log.

Pass `-KeepOld` only when the user asks to keep the old tab. Never use it to keep workers alive: a kept tab is an idle session that is never closed. For codex and copilot the new session cannot be confirmed, so the old tab stays.

A fresh session has no cache to lose, so this is the cheap moment to change model. Pass `-Model sonnet` when the next step is a browser errand or well-specified edits; omit it for design, hard debugging, or anything unsettled.

## After handing off

The old session ends; it does not supervise. A large idle session is the costliest overseer: each check-in after its cache expires rebuilds its whole context (about $0.90 for 200k tokens on Opus). If the work needs oversight, oversee from a small coordinator session, and have the new session report once, on completion or when blocked.

Otherwise reply with only the path and the resume line, in one code block:

```
Read <absolute path> and continue from "Next step".
```
