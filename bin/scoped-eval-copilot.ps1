# Synthetic-only permissions adapter. No shell, network tools, arbitrary paths or delegation.
$ErrorActionPreference = 'Stop'
$forward = @($args)
$prompt = @($input) -join "`n"
if (-not $env:AGENT_KIT_EVAL_MANIFEST) { throw 'Requires an operator-prepared synthetic eval manifest.' }
if ($forward -contains '--allow-all' -or $forward -contains '--allow-all-tools' -or $forward -contains '--allow-all-paths') {
    throw 'The scoped eval adapter cannot be used with unrestricted permissions.'
}
$manifest = Get-Content $env:AGENT_KIT_EVAL_MANIFEST -Raw | ConvertFrom-Json
$cwd = (Get-Location).Path
$item = @($manifest.items | Where-Object { [IO.Path]::GetFullPath($_.cwd) -eq $cwd })
if ($item.Count -ne 1 -or -not $item[0].write_files) { throw "No unique synthetic write allowlist for $cwd" }
$forward += @('--available-tools', 'view', 'glob', 'grep', 'apply_patch',
    '--deny-tool', 'shell', '--deny-tool', 'url', '--disallow-temp-dir', '--sync-session=off', '--add-dir', $cwd)
foreach ($file in $item[0].write_files) {
    $path = [IO.Path]::GetFullPath($file, $cwd)
    if (-not $path.StartsWith($cwd + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Write allowlist escapes synthetic repository.' }
    $forward += @('--allow-tool', "write($path)")
}
if ($env:AGENT_KIT_EVAL_SESSION_FILE -and (Test-Path $env:AGENT_KIT_EVAL_SESSION_FILE)) {
    $session = (Get-Content $env:AGENT_KIT_EVAL_SESSION_FILE -Raw).Trim()
    if ($session -notmatch '^[0-9a-f-]{36}$') { throw 'Invalid benchmark session identity.' }
    $forward += @('--resume', $session)
}
$prompt | & copilot @forward
exit $LASTEXITCODE
