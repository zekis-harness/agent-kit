<#
.SYNOPSIS
Records whether a worker's output was accepted, so bin/report.ps1 can compute cost per accepted task.

.PARAMETER Run
The run id printed at the end of a dispatch (run=<id>), or the report path.

.PARAMETER Outcome
accepted: used as is or with trivial edits. rework: needed real fixes. escalated: redone a tier up
or by the orchestrator. discarded: thrown away.

.EXAMPLE
verdict.ps1 -Run 3f2a9c1d0b7e -Outcome accepted
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Run,
    [Parameter(Mandatory)][ValidateSet('accepted', 'rework', 'escalated', 'discarded')][string]$Outcome,
    [string]$Note = '',
    [string]$Ledger = $(if ($env:AGENT_KIT_LEDGER) { $env:AGENT_KIT_LEDGER } else { Join-Path $HOME '.agent-handoffs/ledger.jsonl' })
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Ledger)) { throw "No ledger at $Ledger" }
$runs = Get-Content $Ledger | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } } | Where-Object type -eq 'dispatch'
$match = $runs | Where-Object { $_.run -eq $Run -or $_.report -eq $Run } | Select-Object -Last 1
if (-not $match) { throw "No dispatch run '$Run' in $Ledger" }
$entry = [ordered]@{ type = 'verdict'; run = $match.run; ts = (Get-Date).ToUniversalTime().ToString('o'); outcome = $Outcome; note = $Note }
Add-Content -Path $Ledger -Value ($entry | ConvertTo-Json -Compress) -Encoding utf8
Write-Output "recorded $Outcome for run $($match.run) ($($match.harness)/$($match.tier) $($match.model))"
