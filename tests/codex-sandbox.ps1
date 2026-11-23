<#
.SYNOPSIS
Opt-in, auth-free filesystem and network checks using the official Windows Codex sandbox.
.DESCRIPTION
Runs only in disposable fixtures. Requires Codex 0.167.0+ and working MXC. No model calls,
personal configuration changes, elevation, or sandbox fallback.
#>
[CmdletBinding()]
param([string]$Exe = 'codex', [string]$NativeExe)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { Write-Output 'skip: the Codex Windows sandbox probe runs on Windows only'; exit 0 }
if (-not $NativeExe) {
    $resolved = (Get-Command $Exe -ErrorAction Stop).Source
    if ([IO.Path]::GetExtension($resolved) -ne '.exe') {
        throw 'Pass -NativeExe with the official codex.exe path to test the native apply_patch helper through a CLI shim.'
    }
    $NativeExe = $resolved
}
. (Join-Path $PSScriptRoot '..\bin\codex-sandbox.ps1')
$root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "agent-kit-codex-$([guid]::NewGuid().ToString('N'))"
$workspace = Join-Path $root 'task workspace'
$outside = Join-Path $root 'outside'
$savedHome = $env:CODEX_HOME
$savedTmpdir = $env:TMPDIR
$failures = 0

function Assert([bool]$Condition, [string]$Name) {
    if ($Condition) { Write-Output "ok   $Name" }
    else { Write-Output "FAIL $Name"; $script:failures++ }
}

function Invoke-Sandbox([string]$Command, [string]$Profile = 'agent-kit') {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
    $policy = Get-CodexWindowsSandboxArgs
    Push-Location $workspace
    try {
        $output = & $Exe @policy sandbox --permission-profile $Profile --include-managed-config -- `
            (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -EncodedCommand $encoded 2>&1
        [pscustomobject]@{ Code = $LASTEXITCODE; Output = ($output -join "`n") }
    } finally { Pop-Location }
}

function Denied-Write([string]$Path) {
    $before = [IO.File]::ReadAllText($Path)
    $literal = $Path.Replace("'", "''")
    $result = Invoke-Sandbox @"
try { [IO.File]::WriteAllText('$literal', 'escaped'); exit 9 }
catch [UnauthorizedAccessException] { 'WRITE_DENIED'; exit 0 }
"@
    Assert ($result.Code -eq 0 -and $result.Output.Contains('WRITE_DENIED') -and [IO.File]::ReadAllText($Path) -eq $before) "sandbox denies write to $([IO.Path]::GetFileName($Path))"
    if ($result.Code -ne 0) { Write-Output $result.Output }
}

try {
    New-Item -ItemType Directory -Force $workspace, $outside | Out-Null
    $env:CODEX_HOME = Join-Path $root 'codex home'
    $env:TMPDIR = $outside
    New-Item -ItemType Directory $env:CODEX_HOME | Out-Null
    # A hostile ambient config must not broaden the explicit invocation profile.
    Set-Content (Join-Path $env:CODEX_HOME 'config.toml') @"
default_permissions = "ambient"
[permissions.ambient.filesystem]
":root" = "write"
[permissions.ambient.network]
enabled = true
"@
    $version = (& $Exe --version) -join "`n"
    $nativeVersion = (& $NativeExe --version) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $nativeVersion -ne $version) { throw 'CLI and native apply_patch helper versions must match.' }
    Write-Output $version
    Assert-CodexWorkspaceWrite -Exe $Exe -Directory $workspace
    Assert (-not (Get-ChildItem $workspace -Filter '.agent-kit-sandbox-*' -Force)) 'real startup probe creates and removes a workspace file'

    # This re-exec entry point is used by the official Windows apply_patch alias.
    $nativeLiteral = $NativeExe.Replace("'", "''")
    $patch = Invoke-Sandbox @"
`$patch = "*** Begin Patch``n*** Add File: patched.txt``n+native patch``n*** End Patch"
& '$nativeLiteral' --codex-run-as-apply-patch `$patch
exit `$LASTEXITCODE
"@
    $patched = Join-Path $workspace 'patched.txt'
    Assert ($patch.Code -eq 0 -and (Test-Path $patched) -and [IO.File]::ReadAllText($patched).Trim() -eq 'native patch') 'official native apply_patch helper creates a workspace file in the safe sandbox'

    $sentinel = Join-Path $outside 'outside-sentinel.txt'
    [IO.File]::WriteAllText($sentinel, 'original')
    Denied-Write $sentinel
    $junction = Join-Path $workspace 'linked outside'
    New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
    Denied-Write (Join-Path $junction 'outside-sentinel.txt')
    $outsideLiteral = $sentinel.Replace('"', '`"')
    $patchDenied = Invoke-Sandbox @"
`$patch = "*** Begin Patch``n*** Update File: $outsideLiteral``n@@``n-original``n+escaped``n*** End Patch"
& '$nativeLiteral' --codex-run-as-apply-patch `$patch
exit `$LASTEXITCODE
"@
    Assert ($patchDenied.Code -ne 0 -and [IO.File]::ReadAllText($sentinel) -eq 'original') 'official native apply_patch helper cannot edit outside the workspace'
    git init -q $workspace
    if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare git fixture' }
    $protected = Join-Path $workspace '.git\protected-sentinel'
    [IO.File]::WriteAllText($protected, 'original')
    Denied-Write $protected

    $readTarget = Join-Path $workspace 'read-only-sentinel'
    [IO.File]::WriteAllText($readTarget, 'original')
    $literal = $readTarget.Replace("'", "''")
    $read = Invoke-Sandbox "try { [IO.File]::WriteAllText('$literal', 'escaped'); exit 9 } catch [UnauthorizedAccessException] { 'READ_ONLY_DENIED'; exit 0 }" ':read-only'
    Assert ($read.Code -eq 0 -and $read.Output.Contains('READ_ONLY_DENIED') -and [IO.File]::ReadAllText($readTarget) -eq 'original') 'official read-only profile denies workspace writes'

    $remote = Join-Path $outside 'remote.git'
    git init --bare -q $remote
    git -C $workspace -c user.name=test -c user.email=test@example.invalid commit -q --allow-empty -m initial
    git -C $workspace -c safe.bareRepository=all push -q $remote HEAD:refs/heads/probe
    if ($LASTEXITCODE -ne 0) { throw 'Unsandboxed local push baseline failed' }
    $before = git --git-dir=$remote rev-parse refs/heads/probe
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read local push baseline ref' }
    git -C $workspace -c user.name=test -c user.email=test@example.invalid commit -q --allow-empty -m second
    $remoteLiteral = $remote.Replace("'", "''")
    $push = Invoke-Sandbox "& git -c safe.bareRepository=all push --no-verify '$remoteLiteral' HEAD:refs/heads/probe; exit `$LASTEXITCODE"
    $after = git --git-dir=$remote rev-parse refs/heads/probe
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read local push result ref' }
    Assert ($push.Code -ne 0 -and $before -eq $after) 'safe sandbox prevents local out-of-workspace git push'

    $worktree = Join-Path $root 'linked worktree'
    git -C $workspace worktree add -q -b sandbox-probe $worktree HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare linked worktree fixture' }
    Assert-CodexWorkspaceWrite -Exe $Exe -Directory $worktree
    $originalWorkspace = $workspace
    $workspace = $worktree
    try { Denied-Write (Join-Path $worktree '.git') }
    finally { $workspace = $originalWorkspace }
    Assert $true 'real workspace write also works in a linked worktree'

    # Establish reachability first so a disconnected host cannot produce a false pass.
    $tcp = [Net.Sockets.TcpClient]::new()
    try { $null = $tcp.ConnectAsync('1.1.1.1', 443).WaitAsync([TimeSpan]::FromSeconds(5)).GetAwaiter().GetResult() }
    finally { $tcp.Dispose() }
    $network = Invoke-Sandbox @'
$tcp = [Net.Sockets.TcpClient]::new()
try {
    $tcp.ConnectAsync('1.1.1.1', 443).WaitAsync([TimeSpan]::FromSeconds(3)).GetAwaiter().GetResult()
    'NETWORK_ESCAPED'; exit 9
} catch [Net.Sockets.SocketException] { 'NETWORK_DENIED'; exit 0 }
catch [TimeoutException] { 'NETWORK_DENIED'; exit 0 }
finally { $tcp.Dispose() }
'@
    Assert ($network.Code -eq 0 -and $network.Output.Contains('NETWORK_DENIED')) 'safe sandbox denies direct outbound TCP with a reachable host baseline'

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        $port = $listener.LocalEndpoint.Port
        $loopback = Invoke-Sandbox @"
`$tcp = [Net.Sockets.TcpClient]::new()
try {
    `$null = `$tcp.ConnectAsync('127.0.0.1', $port).WaitAsync([TimeSpan]::FromSeconds(3)).GetAwaiter().GetResult()
    'LOOPBACK_ESCAPED'; exit 9
} catch [Net.Sockets.SocketException] { 'LOOPBACK_DENIED'; exit 0 }
catch [TimeoutException] { 'LOOPBACK_DENIED'; exit 0 }
finally { `$tcp.Dispose() }
"@
        Assert ($loopback.Code -eq 0 -and $loopback.Output.Contains('LOOPBACK_DENIED')) 'safe sandbox denies a dedicated host-loopback listener'
    } finally { $listener.Stop() }
} finally {
    $env:CODEX_HOME = $savedHome
    $env:TMPDIR = $savedTmpdir
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
exit $failures
