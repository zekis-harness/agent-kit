$ErrorActionPreference = 'Stop'
$kit = Split-Path $PSScriptRoot -Parent
$root = Join-Path ([IO.Path]::GetTempPath()) ('kit-scope-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory $root
$oldPath = $env:PATH
$oldManifest = $env:AGENT_KIT_EVAL_MANIFEST
$oldSession = $env:AGENT_KIT_EVAL_SESSION_FILE
$oldOutput = $env:KIT_SCOPE_TEST_OUT
$failures = 0
function Assert([bool]$ok, [string]$name) {
    if ($ok) { Write-Output "ok   should $name" } else { Write-Output "FAIL should $name"; $script:failures++ }
}
try {
    $env:KIT_SCOPE_TEST_OUT = Join-Path $root 'args.json'
    Set-Content (Join-Path $root 'copilot.ps1') '@($args) | ConvertTo-Json | Set-Content $env:KIT_SCOPE_TEST_OUT; $null=@($input); exit 0'
    $env:PATH = "$root$([IO.Path]::PathSeparator)$oldPath"
    $env:AGENT_KIT_EVAL_MANIFEST = Join-Path $root 'manifest.json'
    @{items=@(@{cwd=$root;write_files=@('allowed.txt')})} | ConvertTo-Json -Depth 5 | Set-Content $env:AGENT_KIT_EVAL_MANIFEST
    Push-Location $root
    try {
        'synthetic prompt' | & pwsh -NoProfile -File (Join-Path $kit 'bin\scoped-eval-copilot.ps1') --assisted-approval
        $argsSeen = @(Get-Content $env:KIT_SCOPE_TEST_OUT -Raw | ConvertFrom-Json)
        Assert ($argsSeen -contains "write($(Join-Path $root 'allowed.txt'))" -and $argsSeen -notcontains 'write') 'allow only exact synthetic output files'
        $start = [array]::IndexOf($argsSeen, '--available-tools') + 1
        Assert (($argsSeen[$start..($start+3)] -join ',') -eq 'view,glob,grep,apply_patch') 'expose only four file tools'
        Assert ($argsSeen -contains 'shell' -and $argsSeen -contains 'url' -and $argsSeen -contains '--disallow-temp-dir') 'deny shell, URL and implicit temporary paths'
        Assert ($argsSeen -notcontains '--allow-all' -and $argsSeen -notcontains '--allow-all-paths') 'never grant unrestricted tool or path approval'
        Assert ($argsSeen -contains '--sync-session=off') 'keep synthetic session logs out of automatic cloud sync'
        'x' | & pwsh -NoProfile -File (Join-Path $kit 'bin\scoped-eval-copilot.ps1') --allow-all 2>&1 | Out-Null
        Assert ($LASTEXITCODE -ne 0) 'reject attempts to combine the scoped adapter with bypass'
        $env:AGENT_KIT_EVAL_SESSION_FILE = Join-Path $root 'session.txt'
        Set-Content $env:AGENT_KIT_EVAL_SESSION_FILE '12345678-1234-1234-1234-123456789abc'
        'x' | & pwsh -NoProfile -File (Join-Path $kit 'bin\scoped-eval-copilot.ps1')
        $argsSeen = @(Get-Content $env:KIT_SCOPE_TEST_OUT -Raw | ConvertFrom-Json)
        Assert ($argsSeen -contains '--resume' -and $argsSeen[-1] -eq '12345678-1234-1234-1234-123456789abc') 'resume only the explicit benchmark session'
        @{items=@(@{cwd=$root;write_files=@('..\outside.txt')})} | ConvertTo-Json -Depth 5 | Set-Content $env:AGENT_KIT_EVAL_MANIFEST
        'x' | & pwsh -NoProfile -File (Join-Path $kit 'bin\scoped-eval-copilot.ps1') 2>&1 | Out-Null
        Assert ($LASTEXITCODE -ne 0) 'reject a write allowlist escaping the fixture repository'
    } finally { Pop-Location }
} finally {
    $env:PATH = $oldPath
    $env:AGENT_KIT_EVAL_MANIFEST = $oldManifest
    $env:AGENT_KIT_EVAL_SESSION_FILE = $oldSession
    $env:KIT_SCOPE_TEST_OUT = $oldOutput
    Remove-Item -LiteralPath $root -Recurse -Force
}
exit $failures
