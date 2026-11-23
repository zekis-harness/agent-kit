<#
.SYNOPSIS
Links a parked skill pack into one repository so its skills load only there.

.DESCRIPTION
Packs live in ~/.agents/skill-packs/<pack>/<skill>/. Each skill is linked into the repo's
.claude/skills (Claude Code, Copilot) and .agents/skills (Codex), and those paths are added to
the repo's info/exclude (resolved through git, so worktrees work) so they are never committed.
-Remove deletes the junctions and the exclude lines for them.

.EXAMPLE
skill-pack.ps1 -Pack ui
skill-pack.ps1 -List
#>
[CmdletBinding(DefaultParameterSetName = 'Link')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Link')][string]$Pack,
    [Parameter(ParameterSetName = 'Link')][string]$Repo = (Get-Location).Path,
    [Parameter(ParameterSetName = 'Link')][switch]$Remove,
    [Parameter(ParameterSetName = 'List')][switch]$List,
    [string]$PackRoot = (Join-Path $HOME '.agents/skill-packs')
)
$ErrorActionPreference = 'Stop'

if ($List) {
    foreach ($p in Get-ChildItem $PackRoot -Directory) {
        Write-Output "$($p.Name): $((Get-ChildItem $p.FullName -Directory).Name -join ', ')"
    }
    return
}

$source = Join-Path $PackRoot $Pack
if (-not (Test-Path $source)) { throw "No pack '$Pack' in $PackRoot" }
# In a worktree .git is a file, so ask git where info/exclude lives. It may answer relative to $Repo.
$exclude = git -C $Repo rev-parse --git-path info/exclude
if ($LASTEXITCODE -ne 0 -or -not $exclude) { throw "$Repo is not a git repository" }
if (-not [IO.Path]::IsPathRooted($exclude)) { $exclude = Join-Path $Repo $exclude }
$exclude = [IO.Path]::GetFullPath($exclude)
$removed = @()

foreach ($skill in Get-ChildItem $source -Directory) {
    foreach ($rel in ".claude/skills/$($skill.Name)", ".agents/skills/$($skill.Name)") {
        $link = Join-Path $Repo $rel
        if ($Remove) {
            if (Test-Path $link) { (Get-Item $link).Delete(); Write-Output "removed $rel" }
            $removed += "/$rel"
            continue
        }
        if (Test-Path $link) { continue }
        New-Item -ItemType Directory -Force (Split-Path $link) | Out-Null
        New-Item -ItemType $(if ($IsWindows) { "Junction" } else { "SymbolicLink" }) -Path $link -Target $skill.FullName | Out-Null
        New-Item -ItemType Directory -Force (Split-Path $exclude) | Out-Null
        if (-not ((Test-Path $exclude) -and @(Get-Content $exclude) -contains "/$rel")) {
            Add-Content $exclude "/$rel"
        }
        Write-Output "linked $rel"
    }
}

if ($Remove -and (Test-Path $exclude)) {
    $kept = @(Get-Content $exclude | Where-Object { $removed -notcontains $_ })
    Set-Content $exclude $kept
}
