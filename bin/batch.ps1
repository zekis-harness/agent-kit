<#
.SYNOPSIS
Runs a trusted local queue, one fresh dispatch per item, with durable acceptance and explicit retries.
.DESCRIPTION
Manifest: {"items":[{"id":"item","brief":"task.md","cwd":"repo",
"acceptance":{"exe":"node","args":["C:\\trusted\\check.mjs","C:\\repo"]}}]}.
Paths are relative to the manifest. Acceptance is an operator-owned executable, not worker output.
The state directory holds synthetic-labelled briefs, reports, an isolated ledger and atomic state.
On interruption, a completed ledger entry is reconciled without redispatch. Otherwise the item
becomes interrupted and requires -RetryItem plus confirmation that any orphan worker has stopped.
This is explicit at-least-once retry, not an exactly-once guarantee for external side effects.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Manifest,
    [Parameter(Mandatory)][string]$StateDirectory,
    [ValidateSet('copilot', 'claude', 'codex')][string]$Harness = 'copilot',
    [ValidateSet('chore', 'build', 'plan')][string]$Tier = 'build',
    [ValidateSet('safe', 'bypass', 'read')][string]$Mode = 'safe',
    [double]$TimeoutMinutes = 5,
    [ValidateScript({ $_ -eq 0 -or $_ -ge 30 })][double]$MaxCredits = 30,
    [ValidateRange(1, 600)][int]$AcceptanceTimeoutSeconds = 30,
    [ValidateRange(1, 10)][int]$MaxAttempts = 2,
    [string[]]$RetryItem = @(),
    [string[]]$RecheckItem = @(),
    [switch]$OrphansStopped
)
$ErrorActionPreference = 'Stop'
if ($RetryItem.Count -and $RecheckItem.Count) { throw 'Retry and recheck are separate operations.' }
. (Join-Path $PSScriptRoot 'acceptance.ps1')
$Manifest = (Resolve-Path $Manifest).Path
$base = Split-Path $Manifest
$StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
$null = New-Item -ItemType Directory -Force $StateDirectory
$lock = [IO.File]::Open((Join-Path $StateDirectory 'queue.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $statePath = Join-Path $StateDirectory 'state.json'
    $hash = (Get-FileHash $Manifest -Algorithm SHA256).Hash
    $definition = Get-Content $Manifest -Raw | ConvertFrom-Json
    $purpose = if ($definition.corpus_sha -or $definition.purpose -eq 'synthetic-eval') { 'synthetic-eval' } else { 'batch' }
    $label = if ($purpose -eq 'synthetic-eval') { 'synthetic' } else { 'batch' }
    $ledger = Join-Path $StateDirectory "$label-ledger.jsonl"
    if (-not $definition.items -or @($definition.items).Count -gt 100) { throw 'Queue needs 1-100 items.' }
    $ids = @{}
    foreach ($item in $definition.items) {
        if ($item.id -notmatch '^[a-z0-9][a-z0-9-]{0,63}$' -or $ids.ContainsKey($item.id)) { throw "Invalid or duplicate item id: $($item.id)" }
        $ids[$item.id] = $true
        if (-not $item.brief -or -not $item.cwd -or -not $item.acceptance.exe) { throw "Incomplete item: $($item.id)" }
        $item.brief = (Resolve-Path ([IO.Path]::GetFullPath($item.brief, $base))).Path
        $item.cwd = (Resolve-Path ([IO.Path]::GetFullPath($item.cwd, $base))).Path
    }
    function Save-State {
        $temp = "$statePath.tmp"
        [IO.File]::WriteAllText($temp, ($script:state | ConvertTo-Json -Depth 30))
        [IO.File]::Move($temp, $statePath, $true)
    }
    function Read-Ledger {
        if (Test-Path $ledger) {
            # A torn final append is evidence of an interrupted write, not a valid dispatch.
            foreach ($line in Get-Content $ledger) {
                try { $line | ConvertFrom-Json -ErrorAction Stop } catch { Write-Warning "Ignoring incomplete ledger record: $($_.Exception.Message)" }
            }
        }
    }
    if (Test-Path $statePath) {
        $script:state = Get-Content $statePath -Raw | ConvertFrom-Json
        if ($state.manifest_sha -ne $hash -or $state.harness -ne $Harness -or $state.tier -ne $Tier -or $state.mode -ne $Mode) {
            throw 'Manifest or routing changed. Use a new state directory.'
        }
    } else {
        $script:state = [pscustomobject]@{
            version = 1; purpose = $purpose; manifest_sha = $hash
            harness = $Harness; tier = $Tier; mode = $Mode
            items = @($definition.items | ForEach-Object {
                [pscustomobject]@{ id = $_.id; status = 'pending'; attempts = @() }
            })
        }
        Save-State
    }
    foreach ($id in $RetryItem) {
        $target = $state.items | Where-Object id -eq $id
        if (-not $target -or $target.status -notin @('rejected', 'interrupted')) { throw "Retry requires a rejected or interrupted item: $id" }
        if ($target.status -eq 'interrupted' -and -not $OrphansStopped) { throw 'Confirm orphan workers have stopped with -OrphansStopped before retrying.' }
        if ($target.attempts.Count -ge $MaxAttempts) { throw "Attempt limit reached: $id" }
    }
    foreach ($id in $RecheckItem) {
        $target = $state.items | Where-Object id -eq $id
        if (-not $target -or $target.status -notin @('accepted', 'rejected', 'validated') -or -not $target.attempts.Count) {
            throw "Recheck requires an existing completed attempt: $id"
        }
    }
    foreach ($item in $state.items) {
        if ($RecheckItem.Count -and $item.id -notin $RecheckItem) { continue }
        $spec = $definition.items | Where-Object id -eq $item.id
        if ($RecheckItem -contains $item.id) { $item.status = 'running'; Save-State }
        if ($RetryItem -contains $item.id) { $item.status = 'pending'; Save-State }
        if ($item.status -eq 'pending' -and (Test-Path (Join-Path $StateDirectory 'queue.pause'))) {
            Write-Warning 'Queue paused. Remove queue.pause and rerun to continue pending items.'
            break
        }
        if ($item.status -eq 'pending') {
            $number = $item.attempts.Count + 1
            $brief = Join-Path $StateDirectory "$label-$($item.id)-$number.md"
            [IO.File]::WriteAllText($brief, "# ${purpose}: $($item.id)`n`n" + (Get-Content $spec.brief -Raw))
            $attempt = [pscustomobject]@{
                number = $number; brief = $brief; report = [IO.Path]::ChangeExtension($brief, 'report.md')
                run = $null; outcome = $null; acceptance_exit = $null; dispatch_exit = $null
            }
            $item.attempts = @($item.attempts) + $attempt
            $item.status = 'running'
            Save-State
            & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'dispatch.ps1') -Brief $brief -Cwd $spec.cwd `
                -Harness $Harness -Tier $Tier -Mode $Mode -Ledger $ledger `
                -WorkerHome (Join-Path $StateDirectory "worker-$($item.id)-$number") `
                -TimeoutMinutes $TimeoutMinutes -MaxCredits $MaxCredits |
                Set-Content (Join-Path $StateDirectory "$($item.id)-$number.dispatch.txt")
            $attempt.dispatch_exit = $LASTEXITCODE
        }
        if ($item.status -eq 'running') {
            $attempt = $item.attempts[-1]
            $runs = @(Read-Ledger | Where-Object { $_.type -eq 'dispatch' -and $_.report -eq $attempt.report })
            if ($runs.Count -ne 1) {
                $item.status = 'interrupted'
                Save-State
                Write-Warning "$($item.id): no unique completed ledger record; explicit retry required."
                continue
            }
            $attempt.run = $runs[0]
            $checkLog = Join-Path $StateDirectory "$($item.id)-$($attempt.number).acceptance.txt"
            $attempt.acceptance_exit = Invoke-IndependentAcceptance @{
                exe = $spec.acceptance.exe; args = @($spec.acceptance.args); cwd = $base
                log = $checkLog; timeoutSeconds = $AcceptanceTimeoutSeconds
            }
            $attempt.outcome = if ($attempt.run.exit -eq 0 -and $attempt.acceptance_exit -eq 0) { 'accepted' } else { 'rework' }
            $item.status = 'validated'
            Save-State
        }
        if ($item.status -eq 'validated') {
            $attempt = $item.attempts[-1]
            $verdict = Read-Ledger | Where-Object { $_.type -eq 'verdict' -and $_.run -eq $attempt.run.run } | Select-Object -Last 1
            if ($verdict -and $verdict.outcome -ne $attempt.outcome -and $item.id -notin $RecheckItem) { throw "Conflicting verdict for $($item.id); use -RecheckItem for an explicit new acceptance decision." }
            if (-not $verdict -or $verdict.outcome -ne $attempt.outcome) {
                & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'verdict.ps1') -Run $attempt.run.run `
                    -Outcome $attempt.outcome -Note "$purpose item=$($item.id); independent acceptance exit=$($attempt.acceptance_exit)" -Ledger $ledger | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "Verdict failed: $($item.id)" }
            }
            $item.status = if ($attempt.outcome -eq 'accepted') { 'accepted' } else { 'rejected' }
            Save-State
        }
    }
    $state.items | ForEach-Object {
        $run = if ($_.attempts.Count) { $_.attempts[-1].run } else { $null }
        [pscustomobject]@{ item = $_.id; status = $_.status; attempts = $_.attempts.Count
            run = $run.run; session = $run.session_id; input_tokens = $run.input_tokens; cost_usd = $run.cost_usd }
    } | Format-Table -AutoSize
    if (@($state.items | Where-Object status -ne 'accepted').Count) { exit 1 }
} finally { $lock.Dispose() }
