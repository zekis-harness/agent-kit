<#
.SYNOPSIS
Runs one headless worker on a brief file at a model tier, prints its final report, and logs usage.

.DESCRIPTION
The brief plus worker-contract.md is piped to the chosen CLI on stdin (avoids Windows .cmd shims
truncating multi-line arguments). Model and effort come from tiers.json. The final message is written
to <brief>.report.md and printed; the raw output goes to <brief>.log. One JSON line per run (tokens,
cost, duration, status) is appended to the ledger so bin/report.ps1 can compute cost per accepted task.

Copilot workers run with their own COPILOT_HOME (-WorkerHome), so they load the repo's instructions
but none of the user's extensions, skills, MCP servers or global instructions. Claude and Codex
workers still load user-level instructions; worker-contract.md overrides the orchestrator-only rules.

.PARAMETER Brief
Path to the task brief (Markdown). See the delegate skill for the template.

.PARAMETER Harness
Which CLI, and therefore which subscription, runs the worker: claude, codex, or copilot.

.PARAMETER Tier
chore, build, or plan. Mapped to a model and effort per harness in tiers.json.

.PARAMETER Cwd
Repository the worker runs in. Defaults to the current directory.

.PARAMETER Mode
read: read and search only. safe (default): edits and shell, with each harness's no-prompt safety
review (claude auto mode, codex workspace-write sandbox, copilot assisted approval) and no git push.
Windows Codex safe mode requires Codex 0.167.0+ and MXC support; an auth-free write probe fails
closed before calling the model if native sandbox startup or workspace writes are unavailable.
bypass: every approval skipped, the previous default.

.PARAMETER ReadOnly
Same as -Mode read.

.PARAMETER Worktree
Run in a new git worktree on branch agent/<brief>-<time> next to the repo, so parallel workers never
share files. The report names the worktree; accept or discard it with bin/land.ps1.

.PARAMETER TimeoutMinutes
Kill the worker's process tree after this long and report STATUS: failed. 0 disables.

.PARAMETER MaxCredits
Copilot only: soft cap on AI credits for the run (--max-ai-credits). 0 means no cap.

.PARAMETER MaxTurns
Claude only: cap on agent turns (--max-turns). 0 means no cap.

.PARAMETER DryRun
Print the command that would run, without running it or writing anything.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Brief,
    [ValidateSet('claude', 'codex', 'copilot')][string]$Harness = 'claude',
    [ValidateSet('chore', 'build', 'plan')][string]$Tier = 'build',
    [string]$Cwd = (Get-Location).Path,
    [ValidateSet('read', 'safe', 'bypass')][string]$Mode = 'safe',
    [switch]$ReadOnly,
    [switch]$Worktree,
    [double]$TimeoutMinutes = 30,
    [double]$MaxCredits = 0,
    [int]$MaxTurns = 0,
    [string]$Ledger = $(if ($env:AGENT_KIT_LEDGER) { $env:AGENT_KIT_LEDGER } else { Join-Path $HOME '.agent-handoffs/ledger.jsonl' }),
    [string]$WorkerHome = $(if ($env:AGENT_KIT_WORKER_HOME) { $env:AGENT_KIT_WORKER_HOME } else { Join-Path $HOME '.agent-handoffs/.worker-home' }),
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if ($ReadOnly) { $Mode = 'read' }
$kit = Split-Path $PSScriptRoot -Parent
$route = (Get-Content (Join-Path $kit 'tiers.json') -Raw | ConvertFrom-Json).$Harness.$Tier
$briefPath = (Resolve-Path $Brief).Path
$briefName = [IO.Path]::GetFileNameWithoutExtension($briefPath)
$stem = Join-Path (Split-Path $briefPath) $briefName
$report = "$stem.report.md"
$log = "$stem.log"
$prompt = (Get-Content $briefPath -Raw).TrimEnd() + "`n`n" + (Get-Content (Join-Path $kit 'worker-contract.md') -Raw)
$Cwd = (Resolve-Path $Cwd).Path

# Tests point a harness at a stub script through AGENT_KIT_EXE_<HARNESS>.
$exe = [Environment]::GetEnvironmentVariable("AGENT_KIT_EXE_$($Harness.ToUpper())")
if (-not $exe) { $exe = $Harness }

$wtPath = $null
$branch = $null
if ($Worktree) {
    $top = (git -C $Cwd rev-parse --show-toplevel).Trim()
    if ($LASTEXITCODE -ne 0) { throw "-Worktree needs a git repository: $Cwd" }
    $name = "$($briefName -replace '[^\w.-]', '-')-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    $wtPath = Join-Path "$top.agents" $name
    $branch = "agent/$name"
}
$runDir = if ($wtPath) { $wtPath } else { $Cwd }
$codexWindowsSafe = $Harness -eq 'codex' -and $Mode -eq 'safe' -and $IsWindows
if ($codexWindowsSafe) { . (Join-Path $PSScriptRoot 'codex-sandbox.ps1') }

$copilotHome = Join-Path $WorkerHome 'copilot'
switch ($Harness) {
    'claude' {
        $argv = @('-p', '--model', $route.model, '--effort', $route.effort, '--output-format', 'json',
            '--strict-mcp-config', '--exclude-dynamic-system-prompt-sections')
        $argv += switch ($Mode) {
            'read' { @('--allowedTools', 'Read,Grep,Glob') }
            'safe' { @('--permission-mode', 'auto', '--permission-prompts', 'none', '--disallowedTools', 'Bash(git push:*)') }
            'bypass' { @('--dangerously-skip-permissions') }
        }
        if ($MaxTurns -gt 0) { $argv += @('--max-turns', "$MaxTurns") }
    }
    'codex' {
        $argv = @('exec', '-m', $route.model, '-c', "model_reasoning_effort=`"$($route.effort)`"",
            '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '-C', $runDir, '-o', $report)
        $argv += switch ($Mode) {
            'read' { @('-s', 'read-only') }
            'safe' {
                if ($codexWindowsSafe) { Get-CodexWindowsSandboxArgs }
                else { @('-s', 'workspace-write') }
            }
            'bypass' { @('--dangerously-bypass-approvals-and-sandbox') }
        }
        $argv += '-'
    }
    'copilot' {
        $argv = @('--model', $route.model, '--reasoning-effort', $route.effort, '--output-format', 'json', '-s',
            '--no-ask-user', '--disable-builtin-mcps', '--no-auto-update')
        $argv += switch ($Mode) {
            'read' { @('--allow-all-tools', '--deny-tool', 'write', '--deny-tool', 'shell') }
            'safe' { @('--assisted-approval', '--deny-tool', 'shell(git push)') }
            'bypass' { @('--allow-all') }
        }
        if ($MaxCredits -gt 0) { $argv += @('--max-ai-credits', "$MaxCredits") }
    }
}

if ($DryRun) {
    Write-Output "cwd: $runDir"
    if ($wtPath) { Write-Output "worktree: $wtPath (branch $branch)" }
    if ($Harness -eq 'copilot') { Write-Output "COPILOT_HOME: $copilotHome" }
    Write-Output "$exe $($argv -join ' ')"
    Write-Output "report: $report"
    return
}

if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
    throw "The '$Harness' CLI ('$exe') is not installed or not on PATH. Install it, or pick another -Harness; only the harnesses you use need to be installed."
}
if ($wtPath) {
    New-Item -ItemType Directory -Force (Split-Path $wtPath) | Out-Null
    git -C $top worktree add -q -b $branch $wtPath HEAD
    if ($LASTEXITCODE -ne 0) { throw "git worktree add failed for $wtPath" }
}
if ($Harness -eq 'copilot') {
    # A separate home keeps the user's extensions, skills, MCP servers and instructions out of the worker.
    New-Item -ItemType Directory -Force $copilotHome | Out-Null
    $env:COPILOT_HOME = $copilotHome
}

function Get-ChildPids([int]$Parent) {
    # Pipeline output, not member access: an empty `(...).Id` emits one $null, which foreach visits as PID 0.
    if ($IsWindows) { return Get-CimInstance Win32_Process -Filter "ParentProcessId=$Parent" | ForEach-Object ProcessId }
    Get-Process | Where-Object { $_.Parent.Id -eq $Parent } | ForEach-Object Id
}

function Stop-ProcessTree([int]$Root) {
    foreach ($child in Get-ChildPids $Root) {
        Stop-ProcessTree $child
        Stop-Process -Id $child -Force -ErrorAction SilentlyContinue
    }
}

Remove-Item $report, $log -ErrorAction SilentlyContinue
$errFile = "$log.stderr"
$started = Get-Date
$job = Start-ThreadJob -ScriptBlock {
    param($exe, $argv, $prompt, $dir, $errFile, $codexWindowsSafe, $bin, $report)
    Set-Location $dir
    if ($codexWindowsSafe) {
        . (Join-Path $bin 'codex-sandbox.ps1')
        try { Assert-CodexWorkspaceWrite -Exe $exe -Directory $dir }
        catch {
            # A prerequisite failure is a failed run, not a read-only or bypass retry.
            [IO.File]::WriteAllText($errFile, $_.Exception.Message)
            [IO.File]::WriteAllText($report, "STATUS: failed`nNOTES: $($_.Exception.Message)")
            return [pscustomobject]@{ Out = ''; Code = 1 }
        }
    }
    $out = $prompt | & $exe @argv 2> $errFile
    [pscustomobject]@{ Out = ($out -join "`n"); Code = $LASTEXITCODE }
} -ArgumentList $exe, $argv, $prompt, $runDir, $errFile, $codexWindowsSafe, $PSScriptRoot, $report

$timedOut = $false
$limit = if ($TimeoutMinutes -gt 0) { [math]::Max(1, [int]($TimeoutMinutes * 60)) } else { -1 }
if (-not (Wait-Job $job -Timeout $limit)) {
    $timedOut = $true
    Stop-ProcessTree $PID
}
$result = if ($timedOut) { $null } else { Receive-Job $job }
Remove-Job $job -Force
$duration = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
$stdout = if ($result) { [string]$result.Out } else { '' }
$code = if ($timedOut) { 124 } elseif ($null -ne $result.Code) { [int]$result.Code } else { 1 }

$stderr = if (Test-Path $errFile) { Get-Content $errFile -Raw } else { '' }
Remove-Item $errFile -ErrorAction SilentlyContinue
[IO.File]::WriteAllText($log, "$stdout`n--- stderr ---`n$stderr")

function Read-JsonLines([string]$text) {
    foreach ($line in $text -split "`r?`n") {
        if ($line.TrimStart().StartsWith('{')) { try { $line | ConvertFrom-Json -Depth 32 } catch { } }
    }
}

$usage = [ordered]@{ input_tokens = $null; output_tokens = $null; cache_read_tokens = $null; cache_write_tokens = $null; cost_usd = $null; session_id = $null }
$final = $null
switch ($Harness) {
    'copilot' {
        $events = @(Read-JsonLines $stdout)
        $last = $events | Where-Object { $_.type -eq 'assistant.message' -and $_.data.content } | Select-Object -Last 1
        if ($last) { $final = $last.data.content }
        $usage.session_id = ($events | Where-Object type -eq 'result' | Select-Object -Last 1).sessionId
        $checkpoint = $events | Where-Object type -eq 'session.usage_checkpoint' | Select-Object -Last 1
        if ($checkpoint) { $usage.cost_usd = [math]::Round($checkpoint.data.totalNanoAiu / 1e11, 4) }
        $eventsFile = if ($usage.session_id) { Join-Path $copilotHome "session-state/$($usage.session_id)/events.jsonl" }
        if ($eventsFile -and (Test-Path $eventsFile)) {
            $shutdown = @(Read-JsonLines (Get-Content $eventsFile -Raw)) | Where-Object type -eq 'session.shutdown' | Select-Object -Last 1
            $snap = $shutdown.data.accountingSnapshot
            if ($snap) {
                $usage.cost_usd = [math]::Round($snap.totalNanoAiu / 1e11, 4)
                $metrics = @($snap.modelMetrics.PSObject.Properties.Value.usage)
                $usage.input_tokens = ($metrics | Measure-Object inputTokens -Sum).Sum
                $usage.output_tokens = ($metrics | Measure-Object outputTokens -Sum).Sum
                $usage.cache_read_tokens = ($metrics | Measure-Object cacheReadTokens -Sum).Sum
                $usage.cache_write_tokens = ($metrics | Measure-Object cacheWriteTokens -Sum).Sum
            }
        }
    }
    'claude' {
        $doc = try { $stdout | ConvertFrom-Json -Depth 32 } catch { $null }
        if ($doc -and $doc.PSObject.Properties['result']) {
            $final = $doc.result
            $usage.session_id = $doc.session_id
            $usage.cost_usd = $doc.total_cost_usd
            $usage.input_tokens = $doc.usage.input_tokens
            $usage.output_tokens = $doc.usage.output_tokens
            $usage.cache_read_tokens = $doc.usage.cache_read_input_tokens
            $usage.cache_write_tokens = $doc.usage.cache_creation_input_tokens
        } else { $final = $stdout }
    }
    'codex' {
        $turns = @(Read-JsonLines $stdout | Where-Object type -eq 'turn.completed')
        if ($turns) {
            $usage.input_tokens = ($turns.usage | Measure-Object input_tokens -Sum).Sum
            $usage.cache_read_tokens = ($turns.usage | Measure-Object cached_input_tokens -Sum).Sum
            $usage.output_tokens = ($turns.usage | Measure-Object output_tokens -Sum).Sum
        }
    }
}

if ($Harness -ne 'codex' -and $final -and $final.Trim()) { [IO.File]::WriteAllText($report, $final.Trim()) }
if ($timedOut) {
    [IO.File]::WriteAllText($report, "STATUS: failed`nNOTES: timed out after $TimeoutMinutes min, process tree killed; see $log")
} elseif (-not (Test-Path $report)) {
    [IO.File]::WriteAllText($report, "STATUS: failed`nNOTES: no final message, see $log")
}

$reportText = Get-Content $report -Raw
$status = if ($reportText -match '(?m)^STATUS:\s*(\w+)') { $Matches[1].ToLower() } else { 'unknown' }
$runId = [guid]::NewGuid().ToString('N').Substring(0, 12)
$entry = [ordered]@{
    type = 'dispatch'; run = $runId; ts = $started.ToUniversalTime().ToString('o'); harness = $Harness; tier = $Tier
    model = $route.model; effort = $route.effort; mode = $Mode; brief = $briefPath; report = $report; cwd = $runDir
    branch = $branch; exit = $code; status = $status; timed_out = $timedOut; duration_s = $duration
}
foreach ($k in $usage.Keys) { $entry[$k] = $usage[$k] }
New-Item -ItemType Directory -Force (Split-Path $Ledger) | Out-Null
Add-Content -Path $Ledger -Value ($entry | ConvertTo-Json -Compress) -Encoding utf8

Write-Output $reportText
if ($wtPath) {
    Write-Output "`nWORKTREE: $wtPath  BRANCH: $branch"
    git -C $wtPath status --short | Select-Object -First 20
}
$cost = if ($null -ne $usage.cost_usd) { " cost=`$$($usage.cost_usd)" } else { '' }
Write-Output "`n[$Harness/$Tier $($route.model) exit=$code ${duration}s$cost run=$runId] report: $report"
exit $code
