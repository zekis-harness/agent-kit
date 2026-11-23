---
name: backlog-burndown
description: This skill should be used when the user asks to "burn down the backlog", "work the backlog", "knock out the easy issues", "fix the top N issues", "clear the issue backlog", "work on the easiest open issues", or otherwise wants a batch of existing GitHub issues triaged by effort and then actually fixed, verified and shipped as PRs. Runs repeatably — re-triages the live backlog every time, so it can be invoked as often as there are open issues.
version: 0.1.0
---

# Backlog burndown

## What this is

A repeatable loop: read the live issue backlog, rank it by how cheap each item
is to fix relative to what it's worth, pick a slate, then actually ship the
fixes as reviewed, merged PRs.

It is **stateless by design**. Every run re-reads the backlog from GitHub, so
running it ten times in a row is safe — each run simply finds a different (and
shrinking) set of work. Never hardcode a slate of issue numbers into a run;
derive it fresh.

Default slate size is **10 issues**. The user may ask for a different N, or for
a specific label, milestone or theme.

---

## Step 1 — Load the ground rules before touching anything

Read, in this order, whichever exist:

1. `CLAUDE.md` / `AGENTS.md` / `.github/copilot-instructions.md` at repo root
2. `CONTRIBUTING.md`
3. The repo's CI workflows in `.github/workflows/`

Repo conventions **override anything in this skill**. Pay particular attention
to house style on comments, commit format, branch naming, and any explicitly
forbidden actions.

Then establish the baseline so you can tell your own breakage apart from
pre-existing breakage:

```
git status                # must be clean before starting
git checkout main && git pull
```

Run the full local CI equivalent **before writing any code** — lint, typecheck,
format check, tests, build. Record what already fails. A check that was red
before you started is not your regression, and you must not "fix" it silently
or let it block the run. If something is already red, say so in the final
report.

---

## Step 2 — Pull and triage the backlog

```
gh issue list --state open --limit 100 --json number,title,labels,body,comments,createdAt,assignees
```

Also pull open PRs, so you don't duplicate in-flight work:

```
gh pr list --state open --limit 50 --json number,title,headRefName,body
```

Score every open issue on four axes. Be honest — the cost of a wrong "easy"
call is a half-finished PR.

**Effort** — the dominant factor.
- *Small*: config/metadata change, copy change, a single well-understood
  function, adding a missing guard, a dependency bump with a green suite.
- *Medium*: touches several files, needs a new test, or needs light design
  judgment.
- *Large*: schema/migration work, auth or permissions changes, cross-cutting
  refactors, anything needing a new dependency or infrastructure.

**Confidence** — does the issue already state the fix, with file:line pointers
and a reproduction? A well-written issue with a named fix is dramatically
cheaper than a vague complaint. Low confidence promotes an item's effective
effort by one level.

**Risk** — can getting it wrong reach production users or corrupt data?
Auth, permissions, payments, migrations and data deletion are high risk
regardless of how few lines they touch. High risk is not disqualifying, but
it demands real verification, which costs time — price that in.

**Value** — security and data-integrity bugs first, then broken core user
journeys, then papercuts, then polish. A trivial fix nobody benefits from is
still a poor use of a slot.

**Rank by lowest effort first, breaking ties by highest value.** That is what
"easiest" means here, with the guardrail that a zero-value change never makes
the slate just because it's cheap.

### Exclude from the slate

- Anything with an open PR or an existing branch already addressing it.
- Anything assigned to a human.
- Anything blocked on something you cannot do: a paid plan, a credential you
  don't have, a third-party account, an access upgrade. Note it in the report
  instead.
- Anything that needs a product or design decision the issue doesn't settle.
  Ask the user; don't invent the answer.
- Feature requests dressed as issues, unless the user asked for features.
- **Anything already fixed.** On repeat runs this is common. Verify against the
  current code before selecting — if the issue is stale, close it with a short
  comment pointing at the commit or PR that fixed it, and take the next
  candidate. Closing stale issues is real output, not a detour.

---

## Step 3 — Show the slate, then start

Present the ranked slate as a short table: number, title, why it's cheap,
what the fix is, and the risk level. Include the items you *considered and
rejected*, one line each, so the user can overrule you.

Start work immediately after presenting. Do not wait for approval unless an
item needs a product decision or is irreversible — in that case ask about that
item specifically and keep moving on the rest.

---

## Step 4 — Work the slate

Take issues **in order**, one at a time. Do not start five in parallel and
leave a dirty tree.

For each issue:

1. Reproduce the problem first, or otherwise confirm it is real. An issue
   asserting a bug is not proof of one. If you can't reproduce it, say so and
   either dig until you understand why or drop it from the slate.
2. Fix the actual cause, not the symptom.
3. Add or update a test that would have caught it, where the codebase has a
   test suite and the bug is testable. Match existing test conventions —
   find a neighbouring test file and follow its structure.
4. Exercise the change for real: run it, click it, call it. Reading the diff
   is not verification.
5. Update any documentation the change invalidates.

### Batching into PRs

Do **not** put ten unrelated fixes in one PR — it's unreviewable and one bad
fix blocks the other nine.

- Group issues that touch the same area or share a root cause into one PR.
- Otherwise, one PR per issue.
- Within a PR, still commit per logical concern.

Keep each PR independently mergeable. If two fixes genuinely conflict, ship
the first and rebase the second.

### When an issue turns out to be bigger than triaged

Stop. Don't let a "small" item quietly become a refactor. Either:

- ship the narrow, correct subset and file the remainder as a new issue that
  records *why* it was split and what's still missing, or
- drop it from the slate, comment on the issue with what you learned about the
  real scope, and pull in the next candidate.

Either way, say so in the report. A mis-triaged item is useful information.

### New problems found along the way

You will find things nobody filed. File them as you go, with severity,
reproduction, `file:line` references, real-world impact, and a concrete
proposed fix — matching the depth of the best existing issues in the repo.
Fix it in the current run only if it's in scope and cheap; otherwise the
issue is the deliverable.

---

## Step 5 — Verify before every push

Run the **full** local CI equivalent, not just the tests near your change:
lint, typecheck, format check, full test suite, build.

Compare against the Step 1 baseline. Everything that was green must still be
green. Anything that was already red stays out of scope.

---

## Step 6 — Ship

Per the user's standing workflow: **never stop at a local commit.**

```
git rebase origin/main      # keep the branch current
<run full CI locally>
git push -u origin <branch>
gh pr create ...
<wait for checks>
gh pr merge --squash --delete-branch
```

- Never commit directly to `main`.
- Commit messages: imperative mood, specific, explaining *why* where the diff
  doesn't. Never "WIP" or "fix stuff".
- **No AI attribution trailers** — no `Co-authored-by: Claude`, no
  `Co-authored-by: Copilot`, no session lines. Commits are authored as the
  user only.
- Link issues with `Closes #N` so merging closes them automatically. Verify
  they actually closed.
- Write PR bodies that explain the problem, the cause, the fix and the
  evidence it works. Include reproduction results and before/after where it
  helps a reviewer.

If a required check fails, fix it. If a check is *known-broken repo-wide*
(verify by looking at its history on other branches, not by assuming), say so
explicitly and don't treat it as a blocker.

If a step is genuinely blocked — no remote, no `gh` auth, a merge conflict you
shouldn't unilaterally resolve, a failing required check you can't fix — stop
there and report exactly what's blocking.

---

## Step 7 — Report back

End with:

- A table: issue → what was wrong → what changed → PR link → merged or not.
- Issues closed as already-fixed or stale.
- Items pulled from the slate mid-run, and why.
- New issues filed, with links.
- Anything blocked on the user: decisions needed, credentials, plan limits.
- Any pre-existing red check you deliberately left alone.

Then state what the next run should pick up.

---

## Traps

**"Easy" is a hypothesis, not a fact.** The issue author's confidence tells you
nothing about the real fix. Re-triage from the code.

**A test that passes locally isn't proof the bug is fixed.** Confirm the
original reported symptom is gone, through the same path a user would take.

**Fixing the assertion instead of the bug.** If a test fails after your change,
work out whether the test was right before you touch it.

**Shipping ten fixes with one verification pass at the end.** Verify each fix
as you complete it; a late failure then has one obvious cause.

**Closing issues you didn't actually resolve.** If the fix is partial, say
partial, and leave the issue open with a comment on what remains.

**Leaving the tree dirty.** Finish the run with everything committed and
pushed, or state plainly what's left uncommitted and why.
