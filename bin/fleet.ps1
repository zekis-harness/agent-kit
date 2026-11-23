<#
.SYNOPSIS
Runs several briefs at once, one headless dispatch.ps1 worker each, admitted by free memory.

.DESCRIPTION
Each brief becomes one worker. The repository comes from the brief's "Repo:" line (the delegate
template), or -Cwd when a brief has none, so one fleet can span several repositories. A brief may
also carry "Harness:", "Tier:" and "Mode:" lines that override the flags for that worker.

Write-mode workers in a git repository each get their own worktree and branch (dispatch.ps1
-Worktree), so they never share files with each other or with an open session. Land or drop each
with bin/land.ps1.

A worker starts only when a slot is free (-MaxConcurrent), the last start was at least
-StaggerSeconds ago, and available memory minus -ReserveMB per running worker is at least
-MinFreeMB. With nothing running, the queue waits for -MinFreeMB alone. -MinFreeMB 0 turns the
memory check off.

Prints one line per finished worker and a summary table. Reports sit beside each brief
(<brief>.report.md); usage goes to the same ledger dispatch.ps1 writes. Exit code 1 when any
worker did not report STATUS: done.

.EXAMPLE
fleet.ps1 -Brief ~/.agent-handoffs/tasks/a.md, ~/.agent-handoffs/tasks/b.md -Tier build

.EXAMPLE
fleet.ps1 -Brief ~/.agent-handoffs/tasks/sprint-*.md -Harness copilot -MaxConcurrent 3 -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string[]]$Brief,
    [ValidateSet('claude', 'codex', 'copilot')][string]$Harness = 'claude',
    [ValidateSet('chore', 'build', 'plan')][string]$Tier = 'build',
    [ValidateSet('read', 'safe', 'bypass')][string]$Mode = 'safe',
    [string]$Cwd,
    [ValidateRange(1, 16)][int]$MaxConcurrent = 4,
    [ValidateRange(0, 1048576)][int]$MinFreeMB = 1500,
    [ValidateRange(0, 1048576)][int]$ReserveMB = 600,
    [ValidateRange(0, 600)][int]$StaggerSeconds = 3,
    [double]$TimeoutMinutes = 30,
    [switch]$NoWorktree,
    [string]$Ledger = $(if ($env:AGENT_KIT_LEDGER) { $env:AGENT_KIT_LEDGER } else { Join-Path $HOME '.agent-handoffs/ledger.jsonl' }),
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$dispatch = Join-Path $PSScriptRoot 'dispatch.ps1'
$pwshExe = Join-Path $PSHOME ($IsWindows ? 'pwsh.exe' : 'pwsh')

function Get-AvailableMB {
    if ($IsWindows) { return [int](Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).AvailableMBytes }
    if (Test-Path /proc/meminfo) {
        $line = Select-String -Path /proc/meminfo -Pattern '^MemAvailable:\s+(\d+)' | Select-Object -First 1
        if ($line) { return [int]([long]$line.Matches[0].Groups[1].Value / 1024) }
    }
    [int]::MaxValue
}

function Read-BriefField([string]$Text, [string]$Name, [string[]]$Allowed) {
    if ($Text -notmatch "(?m)^${Name}:[ \t]*(\S+)") { return $null }
    $value = $Matches[1].ToLower()
    if ($value -notin $Allowed) { throw "Brief has ${Name}: $value; expected one of $($Allowed -join ', ')" }
    $value
}

$paths = foreach ($pattern in $Brief) {
    $found = @(Resolve-Path $pattern -ErrorAction SilentlyContinue | ForEach-Object Path)
    if (-not $found) { throw "No brief matches: $pattern" }
    $found
}
$paths = @($paths | Where-Object { $_ -notmatch '\.report\.md$' } | Select-Object -Unique)
if (-not $paths) { throw 'No briefs to run.' }

$items = foreach ($path in $paths) {
    $text = Get-Content $path -Raw
    $repo = if ($text -match '(?m)^Repo:[ \t]*(.+?)(?:[ \t]{2,}Branch:.*)?[ \t]*\r?$') { $Matches[1].Trim() } else { $Cwd }
    if (-not $repo) { throw "$path has no 'Repo:' line and -Cwd was not given." }
    if (-not (Test-Path $repo -PathType Container)) { throw "$path names a repository that does not exist: $repo" }
    $itemMode = (Read-BriefField $text 'Mode' @('read', 'safe', 'bypass')) ?? $Mode
    git -C $repo rev-parse --show-toplevel 2>$null | Out-Null
    $isGit = $LASTEXITCODE -eq 0
    [pscustomobject]@{
        id = [IO.Path]::GetFileNameWithoutExtension($path); brief = $path; repo = (Resolve-Path $repo).Path
        harness = (Read-BriefField $text 'Harness' @('claude', 'codex', 'copilot')) ?? $Harness
        tier = (Read-BriefField $text 'Tier' @('chore', 'build', 'plan')) ?? $Tier
        mode = $itemMode; worktree = ($isGit -and $itemMode -ne 'read' -and -not $NoWorktree)
        process = $null; stdout = $null; ledger = $null; started = $null; entry = $null; status = 'pending'
    }
}
$items = @($items)
$clash = $items | Group-Object id | Where-Object Count -gt 1 | Select-Object -First 1
if ($clash) { throw "Two briefs share the file name '$($clash.Name)'; reports and worktrees are named after it." }

function Get-DispatchArgs($item) {
    $list = @('-NoProfile', '-File', $dispatch, '-Brief', $item.brief, '-Cwd', $item.repo, '-Harness', $item.harness,
        '-Tier', $item.tier, '-Mode', $item.mode, '-TimeoutMinutes', "$TimeoutMinutes")
    if ($item.worktree) { $list += '-Worktree' }
    $list
}

if ($DryRun) {
    Write-Output "[fleet] $($items.Count) workers, at most $MaxConcurrent at once, $(Get-AvailableMB) MB available now (floor $MinFreeMB, reserve $ReserveMB per running worker)"
    foreach ($item in $items) {
        Write-Output "--- $($item.id) [$($item.harness)/$($item.tier) $($item.mode)]"
        & $pwshExe @(Get-DispatchArgs $item) -DryRun
    }
    return
}

function Start-Worker($item) {
    $item.ledger = "$($item.brief).fleet-ledger.jsonl"
    Remove-Item $item.ledger -ErrorAction SilentlyContinue
    $info = [Diagnostics.ProcessStartInfo]::new($pwshExe)
    foreach ($a in (Get-DispatchArgs $item) + @('-Ledger', $item.ledger)) { $info.ArgumentList.Add($a) }
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $item.process = [Diagnostics.Process]::Start($info)
    $item.process.StandardInput.Close()
    $item.stdout = $item.process.StandardOutput.ReadToEndAsync()
    $null = $item.process.StandardError.ReadToEndAsync()
    $item.started = Get-Date
    $item.status = 'running'
    Write-Host "[fleet] start $($item.id) [$($item.harness)/$($item.tier)] in $($item.repo)"
}

function Complete-Worker($item) {
    $item.process.WaitForExit()
    $output = $item.stdout.GetAwaiter().GetResult()
    [IO.File]::WriteAllText("$($item.brief).dispatch.txt", $output)
    $line = if (Test-Path $item.ledger) { Get-Content $item.ledger | Select-Object -Last 1 }
    if ($line) {
        $item.entry = $line | ConvertFrom-Json
        New-Item -ItemType Directory -Force (Split-Path $Ledger) | Out-Null
        Add-Content -Path $Ledger -Value $line -Encoding utf8
        Remove-Item $item.ledger
        $item.status = $item.entry.status
    } else {
        $item.status = 'failed'
    }
    $seconds = [int]((Get-Date) - $item.started).TotalSeconds
    $cost = if ($item.entry -and $null -ne $item.entry.cost_usd) { " `$$($item.entry.cost_usd)" } else { '' }
    $where = if ($item.entry.branch) { " worktree: $($item.entry.cwd)" } elseif (-not $item.entry) { " no ledger record, see $($item.brief).dispatch.txt" } else { '' }
    Write-Host "[fleet] $($item.status.PadRight(7)) $($item.id) ${seconds}s$cost$where"
}

$clock = [Diagnostics.Stopwatch]::StartNew()
$lastStart = [datetime]::MinValue
$nextNotice = 0
$peak = 0
try {
    while ($items | Where-Object status -in 'pending', 'running') {
        foreach ($item in @($items | Where-Object { $_.status -eq 'running' -and $_.process.HasExited })) { Complete-Worker $item }
        $running = @($items | Where-Object status -eq 'running').Count
        $next = $items | Where-Object status -eq 'pending' | Select-Object -First 1
        if ($next -and $running -lt $MaxConcurrent -and ((Get-Date) - $lastStart).TotalSeconds -ge $StaggerSeconds) {
            $available = if ($MinFreeMB -gt 0) { Get-AvailableMB } else { [int]::MaxValue }
            if ($MinFreeMB -eq 0 -or ($available - $ReserveMB * $running) -ge $MinFreeMB) {
                Start-Worker $next
                $lastStart = Get-Date
                $peak = [math]::Max($peak, $running + 1)
                continue
            }
            if ($clock.Elapsed.TotalSeconds -ge $nextNotice) {
                $queued = @($items | Where-Object status -eq 'pending').Count
                Write-Host "[fleet] holding $queued queued: $available MB available, $running running, need $($MinFreeMB + $ReserveMB * $running) MB"
                $nextNotice = $clock.Elapsed.TotalSeconds + 60
            }
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    foreach ($item in $items | Where-Object { $_.process -and -not $_.process.HasExited }) {
        $item.process.Kill($true)
        Write-Host "[fleet] stopped $($item.id)"
    }
}

$items | ForEach-Object {
    [pscustomobject]@{ worker = $_.id; status = $_.status; route = "$($_.harness)/$($_.tier)"
        seconds = $_.entry.duration_s; cost_usd = $_.entry.cost_usd; run = $_.entry.run
        output = if ($_.entry.branch) { $_.entry.cwd } else { $_.repo } }
} | Format-Table -AutoSize | Out-String -Width 220 | Write-Output
$serial = ($items.entry.duration_s | Measure-Object -Sum).Sum
$spent = ($items.entry.cost_usd | Measure-Object -Sum).Sum
Write-Output "[fleet] $($items.Count) workers in $([int]$clock.Elapsed.TotalSeconds)s wall, ${serial}s of worker time, peak $peak at once, cost `$$spent"
if (@($items | Where-Object status -ne 'done').Count) { exit 1 }
