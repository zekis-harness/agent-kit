# Agent policy (zekis-harness starter)

Your own instruction files add detail; they never need to repeat this.

## Git

- Branch before the first edit. Never commit or push to `main`/`master`; all work goes through a pull request.
- Small commits with one concern each. Imperative messages that say why when the diff does not.
- Per commit, run the narrowest check that proves it. Before the first push, run the repo's tests, lint and typecheck once. Never commit code that fails a test you ran.
- Finish without asking: rebase on the base branch, push, open the PR (`Fixes #N` for an issue), review your own diff, enable auto-merge, and wait once for checks. Report the PR link.

## Heavy work

- If `heavyJob` is set in `~/.zekis-harness/config.json`, run builds, full test suites, typechecks, installs and image builds through that command. Otherwise run them directly, one at a time.
- Use quiet or failures-only reporters and summarize results; never paste full logs.
- Stop servers you started when done.

## Scope

- At a real architectural fork, ask. Ship the narrow option and file the broader one as an issue.
- Add tests for critical code (money, credentials, health, deleting or migrating user data, code many people depend on). For personal tools, prototypes and sites, verify by running the change. Keep existing tests passing.
- Done means checks pass, the change was exercised end to end, and `git status` is clean or the leftovers are explained. Say what you did not verify.

## Code

- Comments only for public API docs, invariants, non-obvious branches and CLI help. Rationale goes in `DESIGN.md`.
- Delete dead code. Prefer editing existing files. No abstraction without a second use.
- Before storing API keys or OAuth tokens, or building banking, financial or health integrations: `secure-credentials` skill.
- Turning a personal tool into an app others use: `ship-personal-tool` skill.
- Building or restyling UI: `ui-design` and `ui-copy` skills.

## Writing

- Plain words, full sentences, no filler or preamble. No em dashes.

## Browser

- Follow the `use-chrome` skill when a task needs a browser.

## Cost

- Hand off (`handoff` skill) at a task boundary once context passes about 150k tokens, never mid-step.
- Route first (`delegate` skill): small tasks run in one session; bounded work in medium or larger tasks goes to the cheapest capable model. Decisions, review and verification stay with you.
- This policy is the user's standing request to use subagents as the `delegate` skill routes them.
- Read worker reports, not transcripts, and check them against the diff before relaying.
