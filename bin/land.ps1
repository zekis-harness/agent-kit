<#
.SYNOPSIS
Accepts or discards a worker's worktree created by dispatch.ps1 -Worktree.

.DESCRIPTION
-Accept commits the worker's changes on its branch, squash-merges them into the main checkout's
current branch (staged, not committed, so the orchestrator reviews and writes the commit), then
removes the worktree and branch. -Discard removes both without merging.

.EXAMPLE
land.ps1 -Worktree C:\code\app.agents\fix-auth-20261104-101500 -Accept
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Worktree,
    [Parameter(Mandatory, ParameterSetName = 'Accept')][switch]$Accept,
    [Parameter(Mandatory, ParameterSetName = 'Discard')][switch]$Discard
)
$ErrorActionPreference = 'Stop'
$Worktree = (Resolve-Path $Worktree).Path
$branch = (git -C $Worktree rev-parse --abbrev-ref HEAD).Trim()
if (-not $branch.StartsWith('agent/')) { throw "$Worktree is on '$branch', not an agent/ branch" }
$common = (git -C $Worktree rev-parse --path-format=absolute --git-common-dir).Trim()
$main = Split-Path $common -Parent

if ($Accept) {
    git -C $Worktree add -A
    if (git -C $Worktree status --porcelain) {
        git -C $Worktree commit -q -m "Worker output from $branch"
        if ($LASTEXITCODE -ne 0) { throw 'commit in worktree failed' }
    }
    git -C $main merge --squash $branch
    if ($LASTEXITCODE -ne 0) { throw "squash merge of $branch into $main failed; worktree kept" }
}
# SAFETY: a worker may junction node_modules (or any folder) to the main checkout. git worktree
# remove on Windows deletes through junctions, emptying the target, so unlink every link first.
foreach ($link in Get-ChildItem -LiteralPath $Worktree -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue) {
    if ($link.PSIsContainer) { [IO.Directory]::Delete($link.FullName, $false) } else { [IO.File]::Delete($link.FullName) }
}
git -C $main worktree remove --force $Worktree
git -C $main branch -D $branch | Out-Null
if ($Accept) { Write-Output "Staged $branch in $main; review with git diff --cached, then commit." }
else { Write-Output "Discarded $branch." }
