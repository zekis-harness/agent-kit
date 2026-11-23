<#
.SYNOPSIS
Creates or updates ~/.zekis-harness/config.json, then runs bin/sync.ps1.

.DESCRIPTION
Per-user data lives in $env:ZEKIS_HARNESS_HOME (default ~/.zekis-harness). Detects which of claude, codex
and copilot are on PATH and asks about each setting; every question has a flag, so the script also runs
without a terminal. Re-running keeps existing answers as the defaults and updates only what changes.
Writes `kit` as the absolute path of the clone this script lives in. Creates profile.md with empty
headings when it does not exist.

.PARAMETER Harnesses
Agents to install into, for example claude,codex.

.PARAMETER StarterPolicy
Render policy/starter.md into each agent's global instructions file. Use -StarterPolicy:$false to turn off.

.PARAMETER Hooks
Hooks to enable: any of contextGuard, keepWarm, autoSync. Hooks not listed are switched off.

.PARAMETER NoHooks
Switch every hook off.

.PARAMETER HeavyJob
Command template that wraps heavy work (builds, full test runs). Empty string clears it.

.PARAMETER Overlay
Path of an extra kit-shaped folder (skills/, policy/*.md) installed after the kit. Pass several as -Overlay a,b (PowerShell rejects a repeated parameter under -File).

.PARAMETER Yes
Accept the detected or existing value for every question not given as a flag.

.PARAMETER WireHooks
Merge the selected hooks into ~/.claude/settings.json (keeps existing hooks, writes settings.json.bak).

.PARAMETER NoSync
Do not run bin/sync.ps1 afterwards.

.PARAMETER UserHome
Root to treat as the user's home directory. Tests point this at a temp directory.
#>
[CmdletBinding()]
param(
    [string[]]$Harnesses,
    [switch]$StarterPolicy,
    [string[]]$Hooks,
    [switch]$NoHooks,
    [string]$HeavyJob,
    [string[]]$Overlay,
    [switch]$Yes,
    [switch]$WireHooks,
    [switch]$NoSync,
    [string]$UserHome = $HOME
)
$ErrorActionPreference = 'Stop'
$kit = Split-Path $PSScriptRoot -Parent
$harnessNames = @('claude', 'codex', 'copilot')
$hookNames = @('contextGuard', 'keepWarm', 'autoSync')
$configHome = if ($env:ZEKIS_HARNESS_HOME) { $env:ZEKIS_HARNESS_HOME } else { Join-Path $UserHome '.zekis-harness' }
$configPath = Join-Path $configHome 'config.json'
$interactive = -not $Yes -and -not [Console]::IsInputRedirected

function Split-List($values) { @($values | ForEach-Object { "$_" -split '[,;]' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }

function Read-Answer([string]$question, [string]$default) {
    $reply = Read-Host "$question [$default]"
    if ($reply.Trim()) { $reply.Trim() } else { $default }
}

$existing = @{}
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $existing = try { Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -AsHashtable } catch { $null }
    if ($existing -isnot [Collections.IDictionary]) { throw "$configPath is not a valid JSON object; fix or delete it" }
}

# Harnesses
$detected = @($harnessNames | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue })
$defaultHarnesses = if ($existing.harnesses) { @($existing.harnesses) } elseif ($detected) { $detected } else { @('claude') }
if ($PSBoundParameters.ContainsKey('Harnesses')) { $chosen = Split-List $Harnesses }
elseif ($interactive) { $chosen = Split-List (Read-Answer "Agents to install into (claude, codex, copilot; found on PATH: $($detected -join ', '))" ($defaultHarnesses -join ',')) }
else { $chosen = $defaultHarnesses }
$bad = @($chosen | Where-Object { $_ -notin $harnessNames })
if ($bad -or -not $chosen) { throw "Harnesses must be one or more of: $($harnessNames -join ', ')" }
$chosen = @($harnessNames | Where-Object { $_ -in $chosen })

# Starter policy
$existingPolicy = if ($existing.policy -is [Collections.IDictionary]) { $existing.policy } else { @{} }
$starter = if ($PSBoundParameters.ContainsKey('StarterPolicy')) { [bool]$StarterPolicy }
elseif ($interactive) { (Read-Answer 'Install the starter policy into each agent (y/n)' $(if ($existingPolicy.starter -eq $false) { 'n' } else { 'y' })) -match '^[yY]' }
else { $existingPolicy.starter -ne $false }

# Hooks
$existingHooks = if ($existing.hooks -is [Collections.IDictionary]) { $existing.hooks } else { @{} }
$defaultHooks = @($hookNames | Where-Object { $existingHooks[$_] -ne $false })
if ($NoHooks) { $chosenHooks = @() }
elseif ($PSBoundParameters.ContainsKey('Hooks')) { $chosenHooks = Split-List $Hooks }
elseif ($interactive) { $chosenHooks = Split-List (Read-Answer "Hooks to enable ($($hookNames -join ', '), or none)" $(if ($defaultHooks) { $defaultHooks -join ',' } else { 'none' })) }
else { $chosenHooks = $defaultHooks }
$chosenHooks = @($chosenHooks | Where-Object { $_ -ne 'none' })
$badHooks = @($chosenHooks | Where-Object { $_ -notin $hookNames })
if ($badHooks) { throw "Hooks must be any of: $($hookNames -join ', ')" }

# Heavy-work command
$defaultHeavy = if ($existing.heavyJob) { [string]$existing.heavyJob } else { '' }
if ($PSBoundParameters.ContainsKey('HeavyJob')) { $heavy = $HeavyJob }
elseif ($interactive) { $heavy = Read-Answer 'Command that wraps heavy work such as builds (blank for none)' $defaultHeavy; if ($heavy -eq $defaultHeavy -and -not $defaultHeavy) { $heavy = '' } }
else { $heavy = $defaultHeavy }

# Overlays
$defaultOverlays = @($existing.overlays | Where-Object { $_ })
if ($PSBoundParameters.ContainsKey('Overlay')) { $overlays = Split-List $Overlay }
elseif ($interactive) { $overlays = Split-List (Read-Answer 'Overlay folders with private skills or policy, comma separated (blank for none)' ($defaultOverlays -join ',')) }
else { $overlays = $defaultOverlays }
$overlays = @($overlays | ForEach-Object { [IO.Path]::GetFullPath($_) })

$config = [ordered]@{}
foreach ($key in $existing.Keys) { $config[$key] = $existing[$key] }
$config.kit = $kit
$config.harnesses = $chosen
$policy = [ordered]@{}
foreach ($key in $existingPolicy.Keys) { $policy[$key] = $existingPolicy[$key] }
$policy.starter = $starter
if (-not $policy.Contains('extra')) { $policy.extra = @() }
$config.policy = $policy
$hookConfig = [ordered]@{}
foreach ($name in $hookNames) { $hookConfig[$name] = $name -in $chosenHooks }
$config.hooks = $hookConfig
$config.heavyJob = if ($heavy) { $heavy } else { $null }
$config.overlays = $overlays
if (-not $config.Contains('browser')) { $config.browser = [ordered]@{ servers = @() } }

New-Item -ItemType Directory -Force $configHome | Out-Null
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 8) + "`n")
Write-Output "wrote $configPath"

$profilePath = Join-Path $configHome 'profile.md'
if (-not (Test-Path -LiteralPath $profilePath)) {
    [IO.File]::WriteAllText($profilePath, "# Profile`n`nFacts and preferences skills may read. Never committed anywhere.`n`n## About`n`n## UI style`n`n## Browser accounts`n")
    Write-Output "wrote $profilePath"
}

function Add-HookEntry($settings, [string]$event, [string]$script, [hashtable]$extra) {
    if ($settings.hooks -isnot [Collections.IDictionary]) { $settings.hooks = [ordered]@{} }
    $entries = @($settings.hooks[$event])
    $already = $entries | Where-Object { $_ -is [Collections.IDictionary] } | ForEach-Object { $_.hooks } |
        Where-Object { $_ -is [Collections.IDictionary] -and $_.command -like "*$script*" }
    if ($already) { return $false }
    $command = [ordered]@{ type = 'command'; command = "bash `"$((Join-Path $kit "hooks/$script").Replace([char]92, [char]47))`"" }
    foreach ($key in $extra.Keys) { $command[$key] = $extra[$key] }
    $entries = @($entries | Where-Object { $null -ne $_ }) + [ordered]@{ hooks = @($command) }
    $settings.hooks[$event] = $entries
    $true
}

if ($WireHooks -and $chosenHooks) {
    $settingsPath = Join-Path $UserHome '.claude/settings.json'
    $settings = [ordered]@{}
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        $settings = try { Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -AsHashtable } catch { $null }
        if ($settings -isnot [Collections.IDictionary]) { throw "$settingsPath is not a valid JSON object; fix it, then re-run with -WireHooks" }
    }
    $before = $settings | ConvertTo-Json -Depth 20
    if ('contextGuard' -in $chosenHooks) {
        $null = Add-HookEntry $settings 'PostToolUse' 'context-guard.sh' @{}
        $null = Add-HookEntry $settings 'UserPromptSubmit' 'context-guard.sh' @{}
    }
    if ('keepWarm' -in $chosenHooks) { $null = Add-HookEntry $settings 'Stop' 'keep-warm.sh' @{ asyncRewake = $true; timeout = 3100 } }
    if ('autoSync' -in $chosenHooks) { $null = Add-HookEntry $settings 'SessionStart' 'auto-sync.sh' @{} }
    if (($settings | ConvertTo-Json -Depth 20) -ne $before) {
        New-Item -ItemType Directory -Force (Split-Path $settingsPath) | Out-Null
        if (Test-Path -LiteralPath $settingsPath) { Copy-Item -LiteralPath $settingsPath "$settingsPath.bak" -Force }
        [IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 20) + "`n")
        Write-Output "wired hooks into $settingsPath (backup: $settingsPath.bak)"
    } else {
        Write-Output "hooks already wired in $settingsPath"
    }
} elseif ($chosenHooks -and -not $WireHooks) {
    Write-Output 'Hooks are enabled in config but not wired. Re-run with -WireHooks, or install the kit as a Claude Code plugin (plugins ship hooks/hooks.json).'
}

if ('contextGuard' -in $chosenHooks) {
    $state = if ($env:AGENT_KIT_STATE) { $env:AGENT_KIT_STATE } else { Join-Path $UserHome '.agent-handoffs/.state' }
    Write-Output @"

Status line step for context-guard (not done for you):
  Claude Code runs a status line command with JSON on stdin. Have yours write
  context_window.current_usage (input + cache creation + cache read tokens) to
    $state/<session_id>.tokens
  and the rounded context_window.used_percentage to <session_id>.pct.
  Set it under "statusLine" in $(Join-Path $UserHome '.claude/settings.json'). Without this file the guard and keep-warm do nothing.
"@
}

if (-not $NoSync) {
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'sync.ps1') -UserHome $UserHome
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
