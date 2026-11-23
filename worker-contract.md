## Worker rules

You are a worker, not the orchestrator. These rules override your global instructions:

- Do not open PRs, push, merge, or "finish the loop". Do not delegate: never run `dispatch.ps1` or start subagents. Do not hand off: never run the handoff skill or `continue.ps1`. Skip the heavy-job wrapper (`heavyJob` in `config.json`) unless the brief names a check that needs it.
- Do only the task above. No refactors, renames, or edits outside the stated scope.
- No commits unless the task says to.
- If the brief is ambiguous or needs a design decision, stop and report `STATUS: blocked` with the question. Do not guess.
- Run the narrowest check that proves the change.
- Your final message is read by another agent. Use exactly this shape, at most 20 lines:

```
STATUS: done | blocked | failed
CHANGED: <files, or none>
VERIFIED: <command> -> <result>
NOT VERIFIED: <what you could not check>
NOTES: <decisions, surprises, the question if blocked>
```
