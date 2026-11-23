<#
.SYNOPSIS
Bounded Copilot-only accumulated-context comparison for prepared synthetic evals.
.DESCRIPTION
Runs at most ten items from an eval manifest, with one real resumed session and the same tier.
Raw dispatch snapshots are preserved. A separate ledger derives per-item accounting exclusively
from unique durable session.usage_record identities. Missing accounting remains unknown.
This benchmark has no automatic retries or crash recovery; use a new -Out after interruption.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Manifest,
    [Parameter(Mandatory)][string]$Out,
    [ValidateSet('chore', 'build', 'plan')][string]$Tier = 'build',
    [ValidateSet('safe')][string]$Mode = 'safe'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'acceptance.ps1')
$Manifest = (Resolve-Path $Manifest).Path
$definition = Get-Content $Manifest -Raw | ConvertFrom-Json
if (-not $definition.corpus_sha -or $definition.items.Count -gt 10 -or -not $definition.items.Count) { throw 'Requires a prepared synthetic eval manifest with 1-10 items.' }
$Out = [IO.Path]::GetFullPath($Out)
if (Test-Path $Out) { throw 'Baseline output already exists. Never implicitly resume an interrupted measurement.' }
$null = New-Item -ItemType Directory $Out
$rawLedger = Join-Path $Out 'raw-synthetic-ledger.jsonl'
$derivedLedger = Join-Path $Out 'per-item-synthetic-ledger.jsonl'
$workerHome = Join-Path $Out 'worker-home'
$seen = Join-Path $Out 'seen-usage.json'
$sessionFile = Join-Path $Out 'session.txt'
$oldExe = $env:AGENT_KIT_EXE_COPILOT
$oldSession = $env:AGENT_KIT_EVAL_SESSION_FILE
$oldManifest = $env:AGENT_KIT_EVAL_MANIFEST
$env:AGENT_KIT_EXE_COPILOT = Join-Path $PSScriptRoot 'scoped-eval-copilot.ps1'
$env:AGENT_KIT_EVAL_SESSION_FILE = $sessionFile
$env:AGENT_KIT_EVAL_MANIFEST = $Manifest
$rows = @()
try {
    foreach ($item in $definition.items) {
        $brief = Join-Path $Out "synthetic-$($item.id).md"
        $cwd = [IO.Path]::GetFullPath($item.cwd, (Split-Path $Manifest))
        [IO.File]::WriteAllText($brief, "# Synthetic accumulated-context evaluation: $($item.id)`n`nCurrent item repository: $cwd`nWork only in this directory, not previous item directories.`n`n" + (Get-Content $item.brief -Raw))
        & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'dispatch.ps1') -Brief $brief -Cwd $cwd `
            -Harness copilot -Tier $Tier -Mode $Mode -Ledger $rawLedger -WorkerHome $workerHome -TimeoutMinutes 5 -MaxCredits 30 |
            Set-Content (Join-Path $Out "$($item.id).dispatch.txt")
        $run = Get-Content $rawLedger | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object type -eq 'dispatch' | Select-Object -Last 1
        if (-not $run.session_id) { throw 'No real session identity. Raw failure retained; baseline stopped.' }
        if (Test-Path $sessionFile) {
            if ($run.session_id -ne (Get-Content $sessionFile -Raw).Trim()) { throw 'CLI did not resume the same session. Baseline stopped.' }
        } else { Set-Content $sessionFile $run.session_id -NoNewline }
        $events = Join-Path $workerHome "copilot\session-state\$($run.session_id)\events.jsonl"
        $usageFile = Join-Path $Out "$($item.id).usage.json"
        node (Join-Path $PSScriptRoot 'eval-usage.mjs') $events $seen $usageFile
        if ($LASTEXITCODE) { throw 'Durable accounting could not be established. Raw records retained.' }
        $usage = Get-Content $usageFile -Raw | ConvertFrom-Json
        $derived = $run.PSObject.Copy()
        foreach ($field in 'input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','cost_usd') { $derived.$field = $usage.$field }
        $derived | Add-Member -NotePropertyName accounting_basis -NotePropertyValue 'unique-durable-usage-records'
        $derived | ConvertTo-Json -Compress | Add-Content $derivedLedger
        # Prepared eval manifests use the operator-owned Node acceptance checker.
        if ($item.acceptance.exe -ne 'node') { throw 'Baseline accepts only prepared Node eval acceptance commands.' }
        $acceptanceExit = Invoke-IndependentAcceptance @{
            exe = 'node'; args = @($item.acceptance.args); cwd = Split-Path $Manifest
            log = Join-Path $Out "$($item.id).acceptance.txt"; timeoutSeconds = 30
        }
        $outcome = if ($acceptanceExit -eq 0 -and $run.exit -eq 0) { 'accepted' } else { 'rework' }
        & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'verdict.ps1') -Run $run.run -Outcome $outcome `
            -Note "synthetic accumulated-context item=$($item.id); durable per-call accounting" -Ledger $derivedLedger | Out-Null
        if ($LASTEXITCODE) { throw 'Baseline verdict failed.' }
        $rows += [pscustomobject]@{ item=$item.id; outcome=$outcome; run=$run.run; session=$run.session_id; input_tokens=$usage.input_tokens; cost_usd=$usage.cost_usd; usage_records=$usage.usage_records }
        $rows | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Out 'summary.json')
    }
    $rows | Format-Table -AutoSize
    if (@($rows | Where-Object outcome -ne 'accepted').Count) { exit 1 }
} finally {
    $env:AGENT_KIT_EXE_COPILOT = $oldExe
    $env:AGENT_KIT_EVAL_SESSION_FILE = $oldSession
    $env:AGENT_KIT_EVAL_MANIFEST = $oldManifest
}
