# Synthetic evaluations and isolated batches

`pwsh -NoProfile -File bin/eval.ps1 -Out ~/scratch/kit-eval -Repetitions 2`
prepares 20 independent repositories from the versioned ten-case corpus, then
uses the existing dispatcher, ledger and verdict tools. Default routing remains
unchanged. Select `-Harness claude` only on a machine with that CLI authenticated.
`-PrepareOnly` creates fixtures without any model calls. `-Case rename,search`
is available when invoking the script from PowerShell rather than through `-File`.

Acceptance is independent of the worker's self-report: `node evals/check.mjs
CASE REPOSITORY` imports the implementation, tests boundary cases, and runs any
required regression test. The acceptance program lives outside worker directories.
This is a small deterministic regression corpus, not evidence about broad coding
quality or a substitute for cross-family review on realistic tasks.

All generated source, raw CLI logs, state and the `synthetic-ledger.jsonl` remain
local under the chosen output directory. Reports and briefs carry a synthetic
label. Do not import this ledger as ordinary user work. Use the existing
`bin/report.ps1 -Ledger .../state/synthetic-ledger.jsonl` for aggregate
accepted-task cost, rework and median duration. Unknown usage or pricing remains
unknown, not zero. Inspect unpriced counts before interpreting cost averages.

Copilot evals use safe mode plus a synthetic-only permissions adapter: only
view, glob, grep and apply_patch are exposed, shell and URL permissions are denied,
automatic temp-directory access is disabled, and only exact corpus-listed output
files receive write approval. The independent acceptance process runs the tests.
There is no unrestricted bypass, no model shell execution and no dispatcher
default change. This tool-permission boundary is not an operating-system sandbox.

## Generic batch contract

`bin/batch.ps1 -Manifest queue.json -StateDirectory ~/scratch/batch-state`
runs a trusted operator-authored manifest with `items`, each containing a unique
`id`, `brief`, `cwd`, and `acceptance: { exe, args }`. Paths to the brief and
working directory resolve relative to the manifest; acceptance runs from that
directory. Acceptance commands must be noninteractive native executables
(use `pwsh -File` for scripts). The default acceptance timeout is 30 seconds,
including child processes. Never accept a manifest from an untrusted worker.
The default Copilot soft limit is 30 AI credits per attempt, the CLI minimum;
`-MaxCredits 0` disables that limit. The dispatch timeout defaults to five minutes.

Each item launches a new dispatcher process and worker home. There is no overseer
model and no implicit retries. An exclusive file lock serializes access to the
queue; state is replaced atomically. Resuming the same manifest skips completed
items and reconciles a completed dispatch from its unique ledger/report identity.
No completed ledger entry means `interrupted`, not a guessed success.
Create `queue.pause` in the state directory to stop before the next pending item,
then remove it and rerun to continue. Generic queues use `batch-ledger.jsonl`;
prepared corpus queues are explicitly synthetic and use `synthetic-ledger.jsonl`.
Acceptance depends on dispatch exit success and the independent checker, not
the worker's self-reported status. A worker can report unavailable runtime
verification while the operator's external runtime checks prove the task works.
`-RecheckItem item-id` explicitly reruns acceptance without another model call;
if the decision changes, a new verdict is appended and the old record is preserved.

Retry a rejected item explicitly with `-RetryItem item-id`; retry an interrupted
item only after stopping any orphan process and adding `-OrphansStopped`.
The default lifetime limit is two attempts per item. These are explicit
at-least-once semantics: an interrupted worker may already have performed a side
effect. Use idempotent errands or an external idempotency key. This runner does
not promise exactly-once purchases, messages or other external operations.

The manifest hash and routing are pinned to the state directory. Use a new
directory for a changed queue or policy. Keep acceptance code and state outside
worker-writable directories. Safe-mode approval and CLI isolation remain those
of `dispatch.ps1`; synthetic workers are not a security sandbox.

## Measurement boundaries

Use the same tasks, tier, acceptance and ordering for fresh and accumulated
context arms, and retain real session IDs and source accounting locally.
`bin/eval-baseline.ps1 -Manifest .../manifest.json -Out ~/scratch/baseline`
runs a prepared corpus of at most ten items through a benchmark-only resume
adapter. It verifies the real session identity remains constant. The same tier,
mode and checker must be selected for both arms. This path is separate from the
production fresh-item runner. It does not retry or resume after interruption.

Raw snapshots remain untouched in `raw-synthetic-ledger.jsonl`. The separate
`per-item-synthetic-ledger.jsonl` counts only new durable `session.usage_record`
identities (source session, sequence, usage ID), never repeated shutdowns or
checkpoints. Missing/incomplete pricing stays null; conflicting records stop the
measurement. The adapter loads no personal configuration and changes no routing.
Missing Claude transcripts cannot establish the original personal Claude
batch-position hypothesis. Copilot measurements must be labelled separately.
Do not change planner or build routing from a smoke test.
