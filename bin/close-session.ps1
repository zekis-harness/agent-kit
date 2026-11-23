<#
.SYNOPSIS
Ends an agent session and its terminal tab after a delay (Windows only). continue.ps1 starts this in its own
hidden console once the next session is running, so it outlives the tab it closes.

.PARAMETER AgentPid
The agent process (claude.exe or codex.exe) to end.

.PARAMETER AgentStart
The agent's start time in UTC ticks, so a reused PID is never ended.

.PARAMETER ShellPid
The tab's shell, ended with exit code 0 so Windows Terminal closes the tab. 0 skips it.

.PARAMETER ShellStart
The shell's start time in UTC ticks.

.PARAMETER DelaySeconds
Time for the old session to finish its last reply before it is ended.
#>
param(
    [Parameter(Mandatory)][int]$AgentPid,
    [Parameter(Mandatory)][long]$AgentStart,
    [int]$ShellPid = 0,
    [long]$ShellStart = 0,
    [int]$DelaySeconds = 20
)
if (-not $IsWindows) { throw 'close-session.ps1 is Windows-only (it ends processes through kernel32).' }
Add-Type -Namespace AgentKit -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool TerminateProcess(IntPtr process, uint exitCode);
'@
Start-Sleep -Seconds $DelaySeconds
foreach ($target in @(@($AgentPid, $AgentStart), @($ShellPid, $ShellStart))) {
    if (-not $target[0]) { continue }
    $p = Get-Process -Id $target[0] -ErrorAction SilentlyContinue
    if ($p -and $p.StartTime.ToUniversalTime().Ticks -eq $target[1]) {
        [void][AgentKit.Native]::TerminateProcess($p.Handle, 0)
    }
}
