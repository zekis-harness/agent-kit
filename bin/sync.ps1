<#
.SYNOPSIS
Installs the kit's skills and (optionally) its policy into the agents listed in ~/.zekis-harness/config.json.

.DESCRIPTION
Reads config.json from $env:ZEKIS_HARNESS_HOME (default ~/.zekis-harness). Without it, prints how to run
bin/setup.ps1 and exits 1.

Skills: <kit>/skills, then <overlay>/skills for each entry of "overlays" (a later skill with the same name
wins), are installed into the skills root of each configured harness only: ~/.claude/skills,
~/.codex/skills, <copilot home>/skills. The copilot home is $env:COPILOT_HOME when set and non-empty,
otherwise ~/.copilot. A skill folder may hold a kit.json (optional keys: group, harnesses, tracked, needs)
to limit its harnesses or the files that ship.

Each skills root keeps .agent-kit-skills.json: per skill, the relative path and sha256 of every file the
kit installed. A file edited in place (it differs from both the source and the record) is left alone unless
-Force. A file is deleted only when it is in the record, no longer shipped, and unchanged; files not in the
record are never touched. An invalid kit.json stops sync before any write.

Policy: when config policy.starter is true, <kit>/policy/starter.md, then each policy.extra file and each
<overlay>/policy/*.md, is rendered between zekis-harness markers in ~/.claude/CLAUDE.md,
~/.codex/AGENTS.md and <copilot home>/copilot-instructions.md for the configured harnesses. Text outside the
markers is never touched. With no policy content (starter false, nothing extra) the marked block is removed.

.PARAMETER UserHome
Root to treat as the user's home directory. Tests point this at a temp directory.

.PARAMETER Check
Report drift without writing. Exits 1 when any instructions target or installed skill file differs, a
recorded file is due for removal, or a file was edited in place.

.PARAMETER Force
Overwrite installed skill files that were edited in place. Never deletes them.
#>
[CmdletBinding()]
param(
    [string]$UserHome = $HOME,
    [switch]$Check,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
$kit = Split-Path $PSScriptRoot -Parent
$harnessNames = @('claude', 'codex', 'copilot')
$configHome = if ($env:ZEKIS_HARNESS_HOME) { $env:ZEKIS_HARNESS_HOME } else { Join-Path $UserHome '.zekis-harness' }
$configPath = Join-Path $configHome 'config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Write-Output "No config at $configPath. Run: pwsh -NoProfile -File '$(Join-Path $kit 'bin/setup.ps1')'"
    exit 1
}
$config = try { Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -AsHashtable } catch { $null }
if ($config -isnot [Collections.IDictionary]) { throw "$configPath is not a valid JSON object; fix it or re-run bin/setup.ps1" }
$harnesses = @($config.harnesses)
if (-not $harnesses.Count -or ($harnesses | Where-Object { $_ -notin $harnessNames })) { throw "${configPath}: harnesses must list claude, codex, copilot" }
$overlays = @($config.overlays | Where-Object { $_ })
$policyCfg = if ($config.policy -is [Collections.IDictionary]) { $config.policy } else { @{} }

$begin = '<!-- zekis-harness:begin (managed by bin/sync.ps1; edit outside these markers) -->'
$end = '<!-- zekis-harness:end -->'
$pattern = '<!-- zekis-harness:begin[^>]*-->[\s\S]*?<!-- zekis-harness:end -->'

$policyFiles = @()
if ($policyCfg.starter -eq $true) { $policyFiles += Join-Path $kit 'policy/starter.md' }
foreach ($extra in @($policyCfg.extra | Where-Object { $_ })) {
    $policyFiles += if ([IO.Path]::IsPathRooted($extra)) { $extra } else { Join-Path $configHome $extra }
}
foreach ($overlay in $overlays) {
    $dir = Join-Path $overlay 'policy'
    if (Test-Path -LiteralPath $dir -PathType Container) {
        $policyFiles += @(Get-ChildItem -LiteralPath $dir -Filter '*.md' -File | Sort-Object Name | ForEach-Object FullName)
    }
}
$pieces = @(foreach ($file in $policyFiles) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "policy file not found: $file" }
    $text = ([IO.File]::ReadAllText($file)).Trim()
    if ($text) { $text }
})
$block = if ($pieces.Count) { "$begin`n$($pieces -join "`n`n")`n$end" }

$copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $UserHome '.copilot' }
$legacyManifestName = '.agent-kit-skills'
$recordName = '.agent-kit-skills.json'
$allTargets = @{
    claude = Join-Path $UserHome '.claude/CLAUDE.md'
    codex = Join-Path $UserHome '.codex/AGENTS.md'
    copilot = Join-Path $copilotHome 'copilot-instructions.md'
}
$skillRoots = @{
    claude = Join-Path $UserHome '.claude/skills'
    codex = Join-Path $UserHome '.codex/skills'
    copilot = Join-Path $copilotHome 'skills'
}

# kit.json "tracked" glob -> anchored regex: ** spans path segments, * stays within one.
function ConvertTo-GlobRegex([string]$glob) {
    $re = ''
    for ($i = 0; $i -lt $glob.Length) {
        $rest = $glob.Substring($i)
        if ($rest.StartsWith('**/')) { $re += '(?:.*/)?'; $i += 3 }
        elseif ($rest.StartsWith('**')) { $re += '.*'; $i += 2 }
        elseif ($rest[0] -eq '*') { $re += '[^/]*'; $i++ }
        else { $re += [regex]::Escape([string]$rest[0]); $i++ }
    }
    "^$re$"
}

function Test-StringList($value) {
    $value -is [array] -and -not ($value | Where-Object { $_ -isnot [string] -or -not $_ })
}

# Record entries come from disk; never let one address anything outside its skills root.
function Test-SafeRelative($rel) {
    $rel -is [string] -and $rel -and -not [IO.Path]::IsPathRooted($rel) -and $rel -notmatch '[\\:]' -and
        -not ($rel.Split('/') | Where-Object { $_ -in '', '.', '..' })
}

function Get-Sha([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Read-KitSkill([IO.DirectoryInfo]$dir) {
    $name = $dir.Name
    $path = Join-Path $dir.FullName 'kit.json'
    $cfg = @{}
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $cfg = try { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable } catch { $null }
        $problem = if ($cfg -isnot [Collections.IDictionary]) { 'not a JSON object' }
        elseif ($unknown = @($cfg.Keys | Where-Object { $_ -notin 'group', 'harnesses', 'tracked', 'needs' })) { "unknown key $($unknown -join ', ')" }
        elseif ($cfg.ContainsKey('group') -and $cfg.group -isnot [string]) { 'group must be a string' }
        elseif ($cfg.ContainsKey('harnesses') -and -not ((Test-StringList $cfg.harnesses) -and -not ($cfg.harnesses | Where-Object { $_ -notin $harnessNames }))) { 'harnesses must list claude, codex, copilot' }
        elseif ($cfg.ContainsKey('tracked') -and -not (Test-StringList $cfg.tracked)) { 'tracked must be a list of globs' }
        elseif ($cfg.ContainsKey('needs') -and -not (Test-StringList $cfg.needs)) { 'needs must be a list of strings' }
        if ($problem) { throw "skill ${name}: invalid kit.json: $problem" }
    }

    $everything = -not $cfg.ContainsKey('tracked')
    $patterns = @($cfg.tracked | ForEach-Object { ConvertTo-GlobRegex $_ })
    $files = [ordered]@{}
    foreach ($file in Get-ChildItem -LiteralPath $dir.FullName -Recurse -File -Force | Sort-Object FullName) {
        $rel = [IO.Path]::GetRelativePath($dir.FullName, $file.FullName).Replace('\', '/')
        if ($everything -or $rel -cin 'SKILL.md', 'kit.json' -or ($patterns | Where-Object { $rel -cmatch $_ })) {
            $files[$rel] = $file.FullName
        }
    }
    [pscustomobject]@{
        Name = $name
        Harnesses = if ($cfg.ContainsKey('harnesses')) { @($cfg.harnesses) } else { $harnessNames }
        Files = $files
    }
}

function Read-Record([string]$root) {
    $path = Join-Path $root $recordName
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return @{} }
    $data = try { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable } catch { $null }
    if ($data -isnot [Collections.IDictionary]) { throw "$path is not a valid sync record; fix or delete it" }
    $data
}

# Everything that can stop sync is read before the first write. The kit comes first, overlays after it.
$byName = [ordered]@{}
foreach ($source in @($kit) + $overlays) {
    $skillsDir = Join-Path $source 'skills'
    if (-not (Test-Path -LiteralPath $skillsDir -PathType Container)) {
        if ($source -ne $kit) { Write-Warning "overlay has no skills folder: $source" }
        continue
    }
    foreach ($dir in Get-ChildItem -LiteralPath $skillsDir -Directory | Sort-Object Name) { $byName[$dir.Name] = Read-KitSkill $dir }
}
$kitSkills = @($byName.Values)
$records = @{}
foreach ($h in $harnesses) { $records[$h] = Read-Record $skillRoots[$h] }

function Get-Rendered([string]$path) {
    $current = if (Test-Path -LiteralPath $path) { [IO.File]::ReadAllText($path) } else { '' }
    $has = $current -match $pattern
    if (-not $block) {
        if (-not $has) { return $current }
        $left = ([regex]::Replace($current, '(?:\r?\n)*' + $pattern + '[ \t]*(?:\r?\n)?', '')).TrimEnd()
        return $(if ($left) { $left + "`n" } else { $null })
    }
    if ($has) { return [regex]::Replace($current, $pattern, { param($m) $block }) }
    if (-not $current.Trim()) { return $block + "`n" }
    $current.TrimEnd() + "`n`n" + $block + "`n"
}

$drift = @()
foreach ($h in $harnesses) {
    $t = $allTargets[$h]
    $current = if (Test-Path -LiteralPath $t) { [IO.File]::ReadAllText($t) } else { '' }
    $rendered = Get-Rendered $t
    if ($current -eq $rendered -or ($null -eq $rendered -and -not (Test-Path -LiteralPath $t))) { continue }
    $drift += $t
    if ($Check) { continue }
    if ($null -eq $rendered) {
        Remove-Item -LiteralPath $t -Force
        Write-Output "removed $t"
        continue
    }
    New-Item -ItemType Directory -Force (Split-Path $t) | Out-Null
    [IO.File]::WriteAllText($t, $rendered)
    Write-Output "updated $t"
}

function Write-Edited([string]$target) {
    $script:drift += "$target (edited in place)"
    if (-not $Check) { Write-Output "edited in place, left alone: $target" }
}

# Deletes recorded files the kit no longer installs, only when unchanged since the kit wrote them,
# then the folders that became empty, up to and including $dest when $includeDest.
function Remove-Stale([string]$dest, [Collections.IDictionary]$old, [string[]]$rels, [bool]$includeDest) {
    $dirs = @(if ($includeDest) { $dest })
    foreach ($rel in $rels) {
        $target = Join-Path $dest $rel
        if (-not (Test-Path -LiteralPath $target)) { continue }
        if ((Test-Path -LiteralPath $target -PathType Leaf) -and (Get-Sha $target) -eq $old[$rel]) {
            $script:drift += "$target (no longer in kit)"
            if ($Check) { continue }
            Remove-Item -LiteralPath $target -Force
            Write-Output "removed $target"
            $dirs += Split-Path $target
        } else {
            Write-Edited $target
        }
    }
    if ($Check) { return }
    $stop = if ($includeDest) { Split-Path $dest } else { $dest }
    foreach ($dir in $dirs | Select-Object -Unique | Sort-Object Length -Descending) {
        while ($dir.Length -gt $stop.Length -and (Test-Path -LiteralPath $dir -PathType Container) -and
            -not (Get-ChildItem -LiteralPath $dir -Force | Select-Object -First 1)) {
            Remove-Item -LiteralPath $dir -Force
            $dir = Split-Path $dir
        }
    }
}

foreach ($h in $harnesses) {
    $root = $skillRoots[$h]
    $record = $records[$h]
    $here = @($kitSkills | Where-Object { $_.Harnesses -contains $h })
    $new = [ordered]@{}

    foreach ($skill in $here) {
        $dest = Join-Path $root $skill.Name
        $old = if ($record[$skill.Name] -is [Collections.IDictionary]) { $record[$skill.Name] } else { @{} }
        if (Test-Path -LiteralPath $dest -PathType Leaf) {
            Write-Edited $dest
            $new[$skill.Name] = $old
            continue
        }
        $entry = @{}
        foreach ($rel in $skill.Files.Keys) {
            $source = $skill.Files[$rel]
            $target = Join-Path $dest $rel
            $recorded = $old[$rel]
            if (Test-Path -LiteralPath $target -PathType Container) {
                Write-Edited $target
                if ($recorded -is [string]) { $entry[$rel] = $recorded }
                continue
            }
            $sha = Get-Sha $source
            $have = if (Test-Path -LiteralPath $target -PathType Leaf) { Get-Sha $target }
            if ($have -eq $sha) { $entry[$rel] = $sha; continue }
            if ($have -and $have -ne $recorded -and -not ($Force -and -not $Check)) {
                Write-Edited $target
                if ($recorded -is [string]) { $entry[$rel] = $recorded }
                continue
            }
            $drift += $target
            if ($Check) { continue }
            New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
            Copy-Item -LiteralPath $source $target -Force
            Write-Output "installed $target"
            $entry[$rel] = $sha
        }
        $gone = @($old.Keys | Where-Object { -not $skill.Files.Contains($_) -and (Test-SafeRelative $_) })
        Remove-Stale $dest $old $gone $false
        $new[$skill.Name] = $entry
    }

    foreach ($name in @($record.Keys)) {
        if ($new.Contains($name) -or $name -match '[\\/:]' -or $name -in '', '.', '..' -or $record[$name] -isnot [Collections.IDictionary]) { continue }
        $old = $record[$name]
        Remove-Stale (Join-Path $root $name) $old @($old.Keys | Where-Object { Test-SafeRelative $_ }) $true
    }

    if ($Check) { continue }
    $sorted = [ordered]@{}
    foreach ($name in $new.Keys) {
        $files = [ordered]@{}
        foreach ($rel in $new[$name].Keys | Sort-Object) { $files[$rel] = $new[$name][$rel] }
        $sorted[$name] = $files
    }
    $wanted = ($sorted | ConvertTo-Json -Depth 3) + "`n"
    $recordPath = Join-Path $root $recordName
    $legacy = Join-Path $root $legacyManifestName
    $current = if (Test-Path -LiteralPath $recordPath) { [IO.File]::ReadAllText($recordPath) } else { $null }
    if ($current -ne $wanted -and ($null -ne $current -or $new.Count -or (Test-Path -LiteralPath $legacy))) {
        New-Item -ItemType Directory -Force $root | Out-Null
        [IO.File]::WriteAllText($recordPath, $wanted)
        Write-Output "updated $recordPath"
    }
    if (Test-Path -LiteralPath $legacy -PathType Leaf) {
        Remove-Item -LiteralPath $legacy -Force
        Write-Output "removed $legacy"
    }
}

if ($Check) {
    if ($drift) { $drift | ForEach-Object { Write-Output "drift: $_" }; exit 1 }
    Write-Output 'in sync'
}
