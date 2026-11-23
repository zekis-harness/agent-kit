<#
.SYNOPSIS
Checks that every model in tiers.json is still accepted by its CLI and plan.

.DESCRIPTION
Sends a one-line read-only brief through dispatch.ps1 for each harness and tier whose CLI is
installed, and writes the results to ~/.agent-handoffs/probe.json. Each probe is a real model call
(a few cents each); runs land in the ledger like any dispatch. Re-run after a plan or CLI upgrade.

.PARAMETER Harness
Limit to these harnesses. Defaults to every harness in tiers.json.
#>
[CmdletBinding()]
param(
    [string[]]$Harness,
    [string]$Out = (Join-Path $HOME '.agent-handoffs/probe.json')
)
$ErrorActionPreference = 'Stop'
# pwsh -File passes -Harness claude,codex as one string.
$Harness = @($Harness | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
$kit = Split-Path $PSScriptRoot -Parent
$tiers = Get-Content (Join-Path $kit 'tiers.json') -Raw | ConvertFrom-Json
$dispatch = Join-Path $PSScriptRoot 'dispatch.ps1'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('agent-kit-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $scratch | Out-Null
$results = @()
try {
    foreach ($h in $tiers.PSObject.Properties.Name) {
        if ($Harness -and $h -notin $Harness) { continue }
        $exe = [Environment]::GetEnvironmentVariable("AGENT_KIT_EXE_$($h.ToUpper())")
        if (-not $exe -and -not (Get-Command $h -ErrorAction SilentlyContinue)) {
            Write-Output "skip $h (not installed)"
            continue
        }
        foreach ($t in $tiers.$h.PSObject.Properties.Name) {
            $brief = Join-Path $scratch "probe-$h-$t.md"
            Set-Content $brief "# Task: probe`nReply with exactly: STATUS: done"
            $reply = (& pwsh -NoProfile -File $dispatch -Brief $brief -Harness $h -Tier $t -Mode read -TimeoutMinutes 3 -Cwd $scratch) -join "`n"
            $ok = $LASTEXITCODE -eq 0 -and $reply -match 'STATUS:\s*done'
            $results += [pscustomobject]@{ harness = $h; tier = $t; model = $tiers.$h.$t.model; ok = $ok; probed_at = (Get-Date).ToUniversalTime().ToString('o') }
            Write-Output ("{0,-4} {1}/{2} {3}" -f $(if ($ok) { 'ok' } else { 'FAIL' }), $h, $t, $tiers.$h.$t.model)
        }
    }
} finally { Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
$results | ConvertTo-Json | Set-Content $Out
if ($results | Where-Object { -not $_.ok }) { exit 1 }
