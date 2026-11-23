<#
.SYNOPSIS
Starts a fresh agent session from a handoff file in a new terminal tab or window.

.DESCRIPTION
Opens a terminal running the chosen harness with the prompt "Read <handoff> and continue from
'Next step'". Where the terminal opens depends on the platform:

- Windows: a new Windows Terminal tab (wt.exe). Once the new Claude session has written its
  transcript, the old session and its tab are closed after about 20 s (bin/close-session.ps1),
  unless -KeepOld is given or the old session still runs background Bash commands.
- macOS: a new Terminal window through osascript.
- Linux: a new tmux window when run inside tmux, otherwise x-terminal-emulator or gnome-terminal
  when present.
- Anything else: the exact command to run is printed and nothing is launched.

Closing the old session is Windows-only; elsewhere close it yourself.

The new session starts without the variables Claude Code injects into its child processes, so it
is a top-level interactive session with its own id and transcript. For Claude, the working folder
is marked trusted in ~/.claude.json first, because --dangerously-skip-permissions does not skip
the per-folder trust prompt and an unattended tab would wait on it forever.

.PARAMETER Handoff
Path to the handoff Markdown file.

.PARAMETER Cwd
Folder the new session starts in. Defaults to the current directory.

.PARAMETER Harness
claude, codex or copilot. Each must be installed and on PATH.

.PARAMETER ClaudeArgs
Extra arguments for claude. The default skips permission prompts and enables remote control;
replace it with your own flags if you want prompts.

.PARAMETER CopilotCommand
Command that starts Copilot CLI, for setups where the plain `copilot` command is not the one you
want (a wrapper script or an alias-backed function that selects an account, for example). The
prompt is appended as -i '<prompt>'.

.PARAMETER Model
Claude only: model name passed as --model.

.PARAMETER DryRun
Print what would run (and what would be closed) without launching anything.

.PARAMETER WaitSeconds
Claude only: how long to wait for the new session's transcript before warning. 0 skips the wait.

.PARAMETER KeepOld
Do not close the old session after the new one starts (Windows only).
#>
param(
    [Parameter(Mandatory)][string]$Handoff,
    [string]$Cwd = (Get-Location).Path,
    [ValidateSet('claude', 'codex', 'copilot')][string]$Harness = 'claude',
    [string]$ClaudeArgs = '--dangerously-skip-permissions --remote-control',
    [string]$CopilotCommand = 'copilot',
    [string]$Model,
    [switch]$DryRun,
    [string]$StateDir = (Join-Path $HOME '.agent-handoffs/.state'),
    [string]$ClaudeHome = $HOME,
    [int]$WaitSeconds = 90,
    [switch]$KeepOld
)

# The agent session this script runs under, and the tab shell hosting it, so they can be
# ended once the next session has started. Refuses when the session still has Bash tool
# commands running (background jobs, monitors): ending the tab kills everything attached to
# its console. Returns $null when there is nothing to close. Windows only.
function Get-OldSession {
    if (-not $IsWindows) { return $null }
    $all = Get-CimInstance Win32_Process
    $byId = @{}
    foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
    $chain = [System.Collections.Generic.List[int]]::new()
    $id = $PID
    while ($byId.ContainsKey($id) -and -not $chain.Contains($id)) {
        $chain.Add($id)
        $id = [int]$byId[$id].ParentProcessId
    }
    $agentId = $chain | Where-Object { $byId[$_].Name -in 'claude.exe', 'codex.exe' } | Select-Object -First 1
    if (-not $agentId) { return $null }
    $agent = $byId[$agentId]
    $busy = $all | Where-Object {
        $_.ParentProcessId -eq $agentId -and $_.CreationDate -ge $agent.CreationDate -and
        -not $chain.Contains([int]$_.ProcessId) -and $_.CommandLine -match 'shell-snapshots'
    }
    $shell = $byId[[int]$agent.ParentProcessId]
    if ($shell -and -not ($byId[[int]$shell.ParentProcessId].Name -eq 'WindowsTerminal.exe')) { $shell = $null }
    [pscustomobject]@{ Agent = $agent; Shell = $shell; Busy = @($busy) }
}

function Close-OldSession {
    if (-not $IsWindows) { Write-Output 'Closing the old session is Windows-only; close it yourself.'; return }
    $old = Get-OldSession
    if (-not $old) { Write-Output 'No agent session found above this script; nothing to close.'; return }
    if ($old.Busy.Count) {
        Write-Output "Kept the old session open: it still runs $($old.Busy.Count) Bash tool command(s) (PIDs $($old.Busy.ProcessId -join ', ')). Stop them or move long jobs to their own console, then close the tab."
        return
    }
    $ticks = { param($p) if ($p) { (Get-Process -Id $p.ProcessId).StartTime.ToUniversalTime().Ticks } else { 0 } }
    $closer = @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'close-session.ps1'),
        '-AgentPid', $old.Agent.ProcessId, '-AgentStart', (& $ticks $old.Agent),
        '-ShellPid', [int]$old.Shell.ProcessId, '-ShellStart', (& $ticks $old.Shell))
    Start-Process pwsh -WindowStyle Hidden -ArgumentList $closer
    $what = if ($old.Shell) { 'and its tab' } else { '(not in a Windows Terminal tab, so the window stays)' }
    Write-Output "Closing the old session $what in about 20 s (agent PID $($old.Agent.ProcessId)). Pass -KeepOld to keep it."
}
$ErrorActionPreference = 'Stop'
$Cwd = (Resolve-Path $Cwd).Path
if ($Model -and $Harness -ne 'claude') { throw '-Model applies to the claude harness only.' }
if ($Model) { $ClaudeArgs = "$ClaudeArgs --model $Model" }

$Handoff = (Resolve-Path $Handoff).Path
$prompt = "Read $Handoff and continue from ""Next step""."
$quoted = "'" + ($prompt -replace "'", "''") + "'"
$command = switch ($Harness) {
    'claude' { "claude $quoted $ClaudeArgs" }
    'codex' { "codex $quoted" }
    'copilot' { "$CopilotCommand -i $quoted" }
}
$binary = if ($Harness -eq 'copilot') { ($CopilotCommand.Trim() -split '\s+')[0].Trim('"', "'", '&') } else { $Harness }
# The new tab inherits this process's environment. Drop only what Claude Code injects into
# its child processes so the new session is a
# top-level, interactive session with its own id and transcript, plus a lowered demo
# threshold. NO_COLOR and the git/prompt variables are the non-interactive tool-shell
# settings; left in place they make the new session monochrome and block git prompts. User
# settings such as CLAUDE_CODE_PROMPT_CACHE_TTL or CLAUDE_CONFIG_DIR survive.
$inherited = @(
    'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
    'AI_AGENT', 'NO_COLOR', 'GIT_EDITOR', 'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE',
    'COREPACK_ENABLE_AUTO_PIN', 'PSExecutionPolicyPreference', 'NoDefaultCurrentDirectoryInExePath',
    'PYTHONIOENCODING', 'AGENT_KIT_HANDOFF_AT'
)
$command = "'$($inherited -join "','")' | ForEach-Object { Remove-Item ""Env:`$_"" -ErrorAction SilentlyContinue }`n$command"
$title = "continue: $(Split-Path $Handoff -LeafBase)"

# Terminal launch. $launch is the program and arguments to run, or $null when this machine has no
# supported terminal, in which case $manual is the command to run by hand. Windows passes the
# command encoded; the other systems run a launcher script that removes itself, so no quoting
# crosses a terminal's own command line.
$launch = $null
$manual = $null
$launcher = $null
if ($IsWindows) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $inner = @('pwsh', '-NoExit', '-EncodedCommand', $encoded)
    if (Get-Command wt.exe -ErrorAction SilentlyContinue) { $launch = @('wt.exe', '-w', '0', 'new-tab', '-d', $Cwd, '--title', $title) + $inner }
    else { $manual = $inner -join ' ' }
} else {
    $launcher = Join-Path ([IO.Path]::GetTempPath()) "agent-kit-continue-$([guid]::NewGuid().ToString('N').Substring(0, 8)).ps1"
    $inner = @('pwsh', '-NoExit', '-File', $launcher)
    if ($IsMacOS) {
        $shellLine = ($inner | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '
        $script = $shellLine.Replace('\', '\\').Replace('"', '\"')
        $launch = @('osascript', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', "do script `"$script`"", '-e', 'end tell')
    } elseif ($env:TMUX -and (Get-Command tmux -ErrorAction SilentlyContinue)) {
        $launch = @('tmux', 'new-window', '-c', $Cwd, '-n', $title) + $inner
    } elseif (Get-Command x-terminal-emulator -ErrorAction SilentlyContinue) {
        $launch = @('x-terminal-emulator', '-e') + $inner
    } elseif (Get-Command gnome-terminal -ErrorAction SilentlyContinue) {
        $launch = @('gnome-terminal', '--title', $title, '--') + $inner
    } else { $manual = $inner -join ' ' }
}

# --dangerously-skip-permissions does not skip the per-folder trust prompt, and an unattended
# tab would wait on it forever. Mark the folder trusted the way the prompt does.
if ($Harness -eq 'claude') {
    $configPath = Join-Path $ClaudeHome '.claude.json'
    $key = $Cwd -replace '\\', '/'
    $config = if (Test-Path $configPath) { Get-Content $configPath -Raw | ConvertFrom-Json -AsHashtable } else { @{} }
    if (-not $config.projects) { $config.projects = @{} }
    if (-not $config.projects[$key]) { $config.projects[$key] = @{} }
    if (-not $config.projects[$key].hasTrustDialogAccepted) {
        if ($DryRun) { Write-Output "trust: would mark $key as trusted" }
        else {
            $config.projects[$key].hasTrustDialogAccepted = $true
            $config | ConvertTo-Json -Depth 100 | Set-Content $configPath -Encoding utf8NoBOM
            Write-Output "Marked $Cwd as trusted for Claude Code"
        }
    }
}

if ($DryRun) {
    Write-Output "command: $command"
    if ($launch) { Write-Output "launch: $($launch -join ' ')" }
    else { Write-Output "launch: no supported terminal found; would print: $manual" }
    if ($launcher) { Write-Output "launcher script (written at launch): $launcher" }
    if (-not $KeepOld -and $IsWindows) {
        $old = Get-OldSession
        if (-not $old) { Write-Output 'close: no agent session found above this script' }
        elseif ($old.Busy.Count) { Write-Output "close: would keep agent $($old.Agent.ProcessId), busy PIDs $($old.Busy.ProcessId -join ', ')" }
        else { Write-Output "close: would end agent $($old.Agent.ProcessId) and shell $([int]$old.Shell.ProcessId)" }
    }
    exit 0
}

if (Test-Path $StateDir) {
    Get-ChildItem $StateDir -File | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7) | Remove-Item -Force
}
if (-not (Get-Command $binary -ErrorAction SilentlyContinue)) {
    throw "The '$Harness' CLI ('$binary') is not installed or not on PATH. Install it, or pick another -Harness."
}
if ($launcher) {
    $quotedLauncher = "'" + ($launcher -replace "'", "''") + "'"
    $quotedCwd = "'" + ($Cwd -replace "'", "''") + "'"
    [IO.File]::WriteAllText($launcher, "Remove-Item -LiteralPath $quotedLauncher -ErrorAction SilentlyContinue`nSet-Location -LiteralPath $quotedCwd`n$command`n")
}
if (-not $launch) {
    Write-Output "No supported terminal found. Open a terminal in $Cwd and run:"
    Write-Output $manual
    exit 0
}
$launched = Get-Date
& $launch[0] @($launch[1..($launch.Count - 1)])
Write-Output "Opened a new terminal in $Cwd running: $command"

# Confirm the session started: a claude session writes its transcript as soon as it sends
# the resume prompt. No transcript means the tab is stuck on a prompt or failed.
if ($Harness -eq 'claude' -and $WaitSeconds -gt 0) {
    $projectDir = Join-Path $ClaudeHome ('.claude/projects/' + ($Cwd -replace '[^a-zA-Z0-9]', '-'))
    $deadline = $launched.AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $deadline) {
        # The calling session keeps writing its own transcript while this waits; skip it.
        $new = Get-ChildItem $projectDir -Filter *.jsonl -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -gt $launched -and $_.BaseName -ne $env:CLAUDE_CODE_SESSION_ID } | Select-Object -First 1
        if ($new) {
            Write-Output "Session started: $($new.FullName)"
            if (-not $KeepOld) { Close-OldSession }
            exit 0
        }
        Start-Sleep -Seconds 3
    }
    Write-Output "WARNING: no new session transcript in $projectDir after $WaitSeconds s. The tab is likely stuck on a prompt or failed to start; check it."
    exit 1
}
