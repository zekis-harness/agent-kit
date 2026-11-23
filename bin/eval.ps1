<#
.SYNOPSIS
Materializes the versioned synthetic eval corpus and runs it through the ordinary batch/dispatch path.
.DESCRIPTION
No model policy changes. Every repetition gets an independent seeded git repo and acceptance command.
All source logs, briefs, state and ledger stay under -Out. Reuse -Out to resume without reseeding.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Out,
    [ValidateSet('copilot', 'claude', 'codex')][string]$Harness = 'copilot',
    [ValidateSet('chore', 'build', 'plan')][string]$Tier = 'build',
    [ValidateRange(1, 5)][int]$Repetitions = 1,
    [string[]]$Case = @(),
    [switch]$PrepareOnly,
    [ValidateSet('safe', 'read')][string]$Mode = 'safe'
)
$ErrorActionPreference = 'Stop'
$kit = Split-Path $PSScriptRoot -Parent
$Out = [IO.Path]::GetFullPath($Out)
$corpus = Join-Path $kit 'evals\corpus.json'
$cases = @(Get-Content $corpus -Raw | ConvertFrom-Json)
if ($Case.Count) {
    foreach ($id in $Case) { if ($id -notin $cases.id) { throw "Unknown case: $id" } }
    $cases = @($cases | Where-Object { $_.id -in $Case })
}
$manifest = Join-Path $Out 'manifest.json'
if (-not (Test-Path $manifest)) {
    $null = New-Item -ItemType Directory -Force $Out
    $items = @()
    foreach ($rep in 1..$Repetitions) {
        foreach ($task in $cases) {
            $id = "$($task.id)-r$rep"
            $repo = Join-Path $Out $id
            if (Test-Path $repo) { throw "Existing fixture without manifest: $repo. Use a new output directory." }
            $null = New-Item -ItemType Directory $repo
            foreach ($file in $task.files.PSObject.Properties) {
                $path = Join-Path $repo $file.Name
                $null = New-Item -ItemType Directory -Force (Split-Path $path)
                [IO.File]::WriteAllText($path, $file.Value)
            }
            git init -q $repo
            if ($LASTEXITCODE) { throw 'git init failed' }
            git -C $repo add .
            git -C $repo -c user.name=synthetic-eval -c user.email=eval@example.invalid commit -q -m 'Seed synthetic evaluation'
            if ($LASTEXITCODE) { throw 'Fixture commit failed' }
            $brief = Join-Path $Out "$id.md"
            [IO.File]::WriteAllText($brief, "$($task.brief)`n`nScope: this synthetic repository only. Do not edit outside it. Use node for local checks. Do not commit or delegate.")
            $items += @{ id = $id; cwd = $repo; brief = $brief; write_files = @($task.writes)
                acceptance = @{ exe = 'node'; args = @((Join-Path $kit 'evals\check.mjs'), $task.id, $repo) } }
        }
    }
    @{ version = 1; corpus_sha = (Get-FileHash $corpus).Hash; items = $items } |
        ConvertTo-Json -Depth 20 | Set-Content $manifest
} else {
    $existing = Get-Content $manifest -Raw | ConvertFrom-Json
    $expected = @(foreach ($rep in 1..$Repetitions) { foreach ($task in $cases) { "$($task.id)-r$rep" } })
    if ($existing.corpus_sha -ne (Get-FileHash $corpus).Hash -or (@($existing.items.id) -join ',') -ne ($expected -join ',')) {
        throw 'Corpus, case selection or repetitions changed. Use a new output directory.'
    }
}
if ($PrepareOnly) { Write-Output $manifest; return }
$oldExe = $env:AGENT_KIT_EXE_COPILOT
$oldManifest = $env:AGENT_KIT_EVAL_MANIFEST
try {
    if ($Harness -eq 'copilot' -and $Mode -eq 'safe') {
        $env:AGENT_KIT_EXE_COPILOT = Join-Path $PSScriptRoot 'scoped-eval-copilot.ps1'
        $env:AGENT_KIT_EVAL_MANIFEST = $manifest
    }
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'batch.ps1') -Manifest $manifest `
        -StateDirectory (Join-Path $Out 'state') -Harness $Harness -Tier $Tier -Mode $Mode
    $code = $LASTEXITCODE
} finally {
    $env:AGENT_KIT_EXE_COPILOT = $oldExe
    $env:AGENT_KIT_EVAL_MANIFEST = $oldManifest
}
exit $code
