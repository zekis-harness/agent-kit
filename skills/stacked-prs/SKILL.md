---
name: stacked-prs
description: This skill should be used when the user asks to "stack PRs", "use stacked PRs", "create a PR stack", "gh stack", "gs init/add/push/submit", or when a change is large enough to naturally split into a dependent chain of small, reviewable pull requests on a repo with GitHub's Stacked PRs private preview enabled.
version: 0.1.0
---

# GitHub Stacked PRs

## What this is

A stack is a series of pull requests in the same repository where each PR
targets the branch of the PR below it, forming an ordered chain that
ultimately lands on the base branch (e.g. `main`). It exists to break a large
change into focused, independently reviewable layers instead of one giant PR.

This is a **private preview** feature — it only works on repos where it has
been explicitly enabled (GitHub confirms this per-repo in the onboarding
email). Check before assuming it's available on a given repo.

## CLI workflow (`gh stack` / `gs`)

Install once per machine:

```
gh extension install github/gh-stack
gh stack alias        # optional: creates the `gs` shorthand
```

Core commands:

- `gs init <branch-name>` — start a stack, creates the first layer/branch
- `gs add <branch-name>` — add a new layer on top of the current one
- `gs push` — push all branches in the stack to GitHub
- `gs submit` — open the stack as pull requests (one PR per layer, each
  targeting the layer below it)

`gh stack` also handles cascading rebases and navigation between layers from
the terminal, rather than manual `git rebase`/`git checkout` per branch.

## How GitHub renders it

- A stack map UI shows the layer order and lets you navigate between PRs in
  the chain.
- Branch protection rules apply against the final target branch (e.g. `main`)
  for the whole stack, not per-layer.
- CI runs on each PR as if it targeted the final base branch, so each layer
  gets a real, independent signal.

## Merging

Click **Merge** on the *highest* PR in the stack you want to land. That PR
and every unmerged PR below it merge together in a single atomic operation.
Merging a subset (not the full stack) triggers an automatic rebase of the
remaining, still-open layers on top of the new base.

## Operating rule

Do not run the stacking commands (`gs init`/`gs add`/`gs push`/`gs submit`, or merging a stack) unless the user explicitly says to; many users want to drive a new tool themselves. Researching, planning and describing how a change would split into layers is fine. When work reaches the point of creating or submitting a stack, stop and hand it over.

## Source

Docs: https://gh.io/stacks (redirects to https://github.github.com/gh-stack/)
Feedback channel: https://gh.io/stacks-feedback
