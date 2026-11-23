<#
.SYNOPSIS
Summarizes the dispatch ledger: runs, acceptance, cost and time per harness, tier and model.

.DESCRIPTION
Cost per accepted task = total cost of every run in the group / runs judged accepted. Runs without a
verdict count as cost but not as accepted, so record verdicts with bin/verdict.ps1.

.PARAMETER Days
Only include runs from the last N days. 0 includes everything.

.PARAMETER Json
Emit the rows as JSON instead of a table.
#>
[CmdletBinding()]
param(
    [int]$Days = 0,
    [switch]$Json,
    [string]$Ledger = $(if ($env:AGENT_KIT_LEDGER) { $env:AGENT_KIT_LEDGER } else { Join-Path $HOME '.agent-handoffs/ledger.jsonl' })
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Ledger)) { Write-Output "No ledger at $Ledger yet."; return }
$all = Get-Content $Ledger | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } }
$runs = @($all | Where-Object type -eq 'dispatch')
if ($Days -gt 0) {
    $since = (Get-Date).ToUniversalTime().AddDays(-$Days)
    $runs = @($runs | Where-Object { [datetime]$_.ts -ge $since })
}
$verdicts = @{}
foreach ($v in $all | Where-Object type -eq 'verdict') { $verdicts[$v.run] = $v.outcome }

function Get-Median([double[]]$values) {
    if (-not $values) { return $null }
    $sorted = $values | Sort-Object
    $mid = [int][math]::Floor($sorted.Count / 2)
    if ($sorted.Count % 2) { return $sorted[$mid] }
    ($sorted[$mid - 1] + $sorted[$mid]) / 2
}

$rows = foreach ($g in $runs | Group-Object harness, tier, model) {
    $items = $g.Group
    $cost = ($items | Where-Object { $null -ne $_.cost_usd } | Measure-Object cost_usd -Sum).Sum
    $accepted = @($items | Where-Object { $verdicts[$_.run] -eq 'accepted' }).Count
    $judged = @($items | Where-Object { $verdicts.ContainsKey($_.run) }).Count
    $unpriced = @($items | Where-Object { $null -eq $_.cost_usd }).Count
    $rework = @($items | Where-Object { $verdicts[$_.run] -eq 'rework' }).Count
    [pscustomobject]@{
        harness = $items[0].harness; tier = $items[0].tier; model = $items[0].model
        runs = $items.Count; judged = $judged; accepted = $accepted
        rework = $rework
        rework_rate = if ($judged) { [math]::Round($rework / $judged, 3) } else { $null }
        unpriced = $unpriced
        timeouts = @($items | Where-Object timed_out).Count
        cost_usd = if ($unpriced -lt $items.Count) { [math]::Round([double]$cost, 3) } else { $null }
        usd_per_accepted = if ($accepted -and -not $unpriced) { [math]::Round($cost / $accepted, 3) } else { $null }
        median_s = Get-Median @($items | ForEach-Object { [double]$_.duration_s })
    }
}
if ($Json) { $rows | ConvertTo-Json -Depth 3; return }
$rows | Sort-Object harness, tier |
    Format-Table harness, tier, model, runs, accepted, usd_per_accepted, rework_rate, median_s, unpriced -AutoSize
$total = ($runs | Where-Object { $null -ne $_.cost_usd } | Measure-Object cost_usd -Sum).Sum
$unpriced = @($runs | Where-Object { $null -eq $_.cost_usd }).Count
Write-Output ("{0} runs, `${1:N2} recorded cost, {2} without cost data, {3} without a verdict" -f $runs.Count, $total, $unpriced, @($runs | Where-Object { -not $verdicts.ContainsKey($_.run) }).Count)
