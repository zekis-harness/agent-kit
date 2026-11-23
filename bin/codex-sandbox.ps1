function Get-CodexWindowsSandboxArgs {
    # Replace ambient roots; TOML literal strings also survive Windows .cmd shims.
    @(
        '-c', "windows.sandbox='mxc'",
        '-c', "approval_policy='never'",
        '-c', "default_permissions='agent-kit'",
        '-c', "permissions={'agent-kit'={extends=':workspace',workspace_roots={},filesystem={':tmpdir'='read',':slash_tmp'='read'},network={enabled=false}}}"
    )
}

function Assert-CodexWorkspaceWrite([string]$Exe, [string]$Directory) {
    $version = (& $Exe --version 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $version -notmatch 'codex-cli (\d+\.\d+\.\d+)' -or [version]$Matches[1] -lt [version]'0.167.0') {
        throw "Windows Codex safe mode requires official codex-cli 0.167.0 or newer. Found: $version"
    }

    $token = [guid]::NewGuid().ToString('N')
    $path = Join-Path $Directory ".agent-kit-sandbox-$token"
    $escaped = $path.Replace("'", "''")
    $command = "[IO.File]::WriteAllText('$escaped', '$token')"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $policy = Get-CodexWindowsSandboxArgs
    try {
        $result = & {
            Push-Location $Directory
            try {
                $output = & $Exe @policy sandbox --permission-profile agent-kit --include-managed-config -- `
                    (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -EncodedCommand $encoded 2>&1
                [pscustomobject]@{ Code = $LASTEXITCODE; Output = $output }
            } finally { Pop-Location }
        }
        if ($result.Code -ne 0 -or -not (Test-Path -LiteralPath $path) -or [IO.File]::ReadAllText($path) -ne $token) {
            throw "Windows Codex safe-mode workspace write probe failed. MXC must be available and permitted by managed policy; no fallback is used. $($result.Output -join "`n")"
        }
    } finally {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -ErrorAction Stop }
    }
}
