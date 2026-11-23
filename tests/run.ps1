$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$failures = 0

function Assert([bool]$condition, [string]$name) {
    if ($condition) { Write-Output "ok   $name" }
    else { Write-Output "FAIL $name"; $script:failures++ }
}

function New-TempDir {
    $dir = Join-Path ([IO.Path]::GetTempPath()) ('zh-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory $dir | Out-Null
    $dir
}

function Write-File([string]$path, [string]$text) {
    New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
    [IO.File]::WriteAllText($path, $text)
}

# Tests never read or write the real home: every run gets a temp home, and these variables are cleared.
Remove-Item Env:COPILOT_HOME, Env:AGENT_KIT_STATE -ErrorAction SilentlyContinue

# A throwaway kit (copy of the real scripts, fixture skills) next to a throwaway home.
function New-Sandbox {
    $root = New-TempDir
    $kit = Join-Path $root 'kit'
    $userHome = Join-Path $root 'home'
    foreach ($f in 'sync.ps1', 'setup.ps1') { Write-File (Join-Path $kit "bin/$f") ([IO.File]::ReadAllText((Join-Path $repo "bin/$f"))) }
    Write-File (Join-Path $kit 'policy/starter.md') "# Starter`n`nRule one.`n"
    Write-File (Join-Path $kit 'skills/alpha/SKILL.md') "alpha`n"
    Write-File (Join-Path $kit 'skills/alpha/extra.txt') "extra`n"
    Write-File (Join-Path $kit 'skills/beta/SKILL.md') "beta`n"
    Write-File (Join-Path $kit 'skills/beta/kit.json') '{ "harnesses": ["claude"] }'
    New-Item -ItemType Directory $userHome | Out-Null
    [pscustomobject]@{ Root = $root; Kit = $kit; Home = $userHome; Config = Join-Path $userHome '.zekis-harness/config.json' }
}

function Set-Config($sb, [string[]]$harnesses = @('claude', 'codex'), [bool]$starter = $false, [string[]]$extra = @()) {
    $cfg = [ordered]@{
        kit = $sb.Kit; harnesses = $harnesses; policy = [ordered]@{ starter = $starter; extra = $extra }
        hooks = [ordered]@{ contextGuard = $true; keepWarm = $true; autoSync = $true }
        heavyJob = $null; browser = [ordered]@{ servers = @() }
    }
    Write-File $sb.Config ($cfg | ConvertTo-Json -Depth 6)
}

# Runs a script from the sandbox kit with the sandbox home; returns exit code and output.
function Invoke-Kit($sb, [string]$script, [string[]]$arguments = @()) {
    $env:ZEKIS_HARNESS_HOME = Join-Path $sb.Home '.zekis-harness'
    try {
        $out = & pwsh -NoProfile -File (Join-Path $sb.Kit "bin/$script") -UserHome $sb.Home @arguments 2>&1 | Out-String
        [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
    } finally { Remove-Item Env:ZEKIS_HARNESS_HOME -ErrorAction SilentlyContinue }
}

function Read-Json([string]$path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable }

# --- sync: config, harness selection, installs -------------------------------------------------
$sb = New-Sandbox
try {
    $r = Invoke-Kit $sb 'sync.ps1'
    Assert ($r.Code -eq 1 -and $r.Out -match 'setup\.ps1') 'sync without config exits 1 and points at setup'

    Set-Config $sb
    $r = Invoke-Kit $sb 'sync.ps1'
    $skills = Join-Path $sb.Home '.claude/skills'
    Assert ($r.Code -eq 0 -and (Test-Path (Join-Path $skills 'alpha/SKILL.md'))) 'sync installs skills for a configured harness'
    Assert (Test-Path (Join-Path $sb.Home '.codex/skills/alpha/extra.txt')) 'sync installs every file of a skill'
    Assert (-not (Test-Path (Join-Path $sb.Home '.copilot'))) 'sync leaves unconfigured harnesses alone'
    Assert ((Test-Path (Join-Path $skills 'beta/SKILL.md')) -and -not (Test-Path (Join-Path $sb.Home '.codex/skills/beta'))) 'kit.json harnesses limits where a skill installs'
    $record = Read-Json (Join-Path $skills '.zekis-harness-skills.json')
    $sha = (Get-FileHash (Join-Path $skills 'alpha/SKILL.md') -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert ($record.alpha['SKILL.md'] -eq $sha) 'manifest records the sha256 of each installed file'
    Assert ((Invoke-Kit $sb 'sync.ps1' @('-Check')).Code -eq 0) 'check passes right after sync'

    Write-File (Join-Path $sb.Kit 'skills/alpha/SKILL.md') "alpha v2`n"
    $r = Invoke-Kit $sb 'sync.ps1' @('-Check')
    Assert ($r.Code -eq 1 -and $r.Out -match 'drift') 'check reports a changed source'
    Assert ((Get-Content (Join-Path $skills 'alpha/SKILL.md') -Raw) -eq "alpha`n") 'check writes nothing'
    Invoke-Kit $sb 'sync.ps1' | Out-Null
    Assert ((Get-Content (Join-Path $skills 'alpha/SKILL.md') -Raw) -eq "alpha v2`n") 'sync updates an unmodified installed file'

    # In-place edits.
    $installed = Join-Path $skills 'alpha/SKILL.md'
    Write-File $installed "my edit`n"
    Write-File (Join-Path $sb.Kit 'skills/alpha/SKILL.md') "alpha v3`n"
    $r = Invoke-Kit $sb 'sync.ps1'
    Assert ($r.Out -match 'edited in place' -and (Get-Content $installed -Raw) -eq "my edit`n") 'sync reports and keeps a file edited in place'
    Assert ((Invoke-Kit $sb 'sync.ps1' @('-Check')).Code -eq 1) 'check reports a file edited in place'
    Invoke-Kit $sb 'sync.ps1' @('-Force') | Out-Null
    Assert ((Get-Content $installed -Raw) -eq "alpha v3`n") '-Force overwrites a file edited in place'

    # Deletion rules.
    Write-File (Join-Path $skills 'alpha/mine.txt') "not from the kit`n"
    Remove-Item (Join-Path $sb.Kit 'skills/alpha/extra.txt')
    $r = Invoke-Kit $sb 'sync.ps1' @('-Check')
    Assert ($r.Code -eq 1 -and $r.Out -match 'no longer in kit' -and (Test-Path (Join-Path $skills 'alpha/extra.txt'))) 'check reports a stale file without deleting it'
    Invoke-Kit $sb 'sync.ps1' | Out-Null
    Assert (-not (Test-Path (Join-Path $skills 'alpha/extra.txt'))) 'sync deletes an unchanged recorded file the kit dropped'
    Assert (Test-Path (Join-Path $skills 'alpha/mine.txt')) 'sync never touches a file it did not record'
    Assert ((Test-Path (Join-Path $sb.Home '.codex/skills/alpha/SKILL.md')) -and -not (Test-Path (Join-Path $sb.Home '.codex/skills/alpha/extra.txt'))) 'stale deletion applies per harness'

    Write-File (Join-Path $sb.Kit 'skills/alpha/extra.txt') "extra`n"
    Invoke-Kit $sb 'sync.ps1' | Out-Null
    Write-File (Join-Path $skills 'alpha/extra.txt') "edited`n"
    Remove-Item (Join-Path $sb.Kit 'skills/alpha/extra.txt')
    Invoke-Kit $sb 'sync.ps1' | Out-Null
    Assert ((Get-Content (Join-Path $skills 'alpha/extra.txt') -Raw) -eq "edited`n") 'sync keeps an edited file the kit dropped'

    Remove-Item -Recurse (Join-Path $sb.Kit 'skills/beta')
    Invoke-Kit $sb 'sync.ps1' | Out-Null
    Assert (-not (Test-Path (Join-Path $skills 'beta'))) 'sync removes a whole skill the kit dropped when unchanged'
    Assert (-not (Test-Path (Join-Path $sb.Home '.copilot'))) 'removing skills creates nothing for unconfigured harnesses'

    Write-File (Join-Path $skills '.zekis-harness-skills.json') '{ "ghost": { "../escape.txt": "00" } }'
    Write-File (Join-Path $skills '../escape.txt') "keep`n"
    Invoke-Kit $sb 'sync.ps1' | Out-Null
    Assert (Test-Path (Join-Path $sb.Home '.claude/escape.txt')) 'a record entry cannot delete outside its skills root'
} finally { Remove-Item -Recurse -Force $sb.Root }

# --- sync: invalid kit.json -------------------------------------------------------------------
$sb = New-Sandbox
try {
    Set-Config $sb @('claude')
    Write-File (Join-Path $sb.Kit 'skills/beta/kit.json') '{ "bogus": 1 }'
    $r = Invoke-Kit $sb 'sync.ps1'
    Assert ($r.Code -ne 0 -and -not (Test-Path (Join-Path $sb.Home '.claude/skills'))) 'an invalid kit.json stops sync before any write'
} finally { Remove-Item -Recurse -Force $sb.Root }

# --- sync: policy markers ----------------------------------------------------------------------
$sb = New-Sandbox
try {
    $claude = Join-Path $sb.Home '.claude/CLAUDE.md'
    $agents = Join-Path $sb.Home '.codex/AGENTS.md'
    Write-File $claude "My own rules.`n"
    Set-Config $sb @('claude', 'codex') $true
    Invoke-Kit $sb 'sync.ps1' | Out-Null
    $text = Get-Content $claude -Raw
    Assert ($text.StartsWith("My own rules.`n") -and $text -match 'zekis-harness:begin' -and $text -match 'Rule one\.' -and $text -match 'zekis-harness:end') 'starter on renders between markers and keeps outside text'
    Assert ((Get-Content $agents -Raw) -match 'Rule one\.') 'starter renders into each configured harness'
    Assert (-not (Test-Path (Join-Path $sb.Home '.copilot/copilot-instructions.md'))) 'starter skips unconfigured harnesses'
    Assert ((Invoke-Kit $sb 'sync.ps1' @('-Check')).Code -eq 0) 'check passes with the policy block current'

    Write-File $claude ($text.Replace('Rule one.', 'Tampered.') + "Tail text.`n")
    Invoke-Kit $sb 'sync.ps1' | Out-Null
    $text = Get-Content $claude -Raw
    Assert ($text -match 'Rule one\.' -and $text -notmatch 'Tampered' -and $text.TrimEnd().EndsWith('Tail text.')) 'sync restores the block and leaves text after it'

    Set-Config $sb @('claude', 'codex') $false
    $r = Invoke-Kit $sb 'sync.ps1' @('-Check')
    Assert ($r.Code -eq 1) 'check reports a block that starter off would remove'
    Invoke-Kit $sb 'sync.ps1' | Out-Null
    $text = Get-Content $claude -Raw
    Assert ($text -notmatch 'zekis-harness' -and $text -match 'My own rules\.' -and $text -match 'Tail text\.') 'starter off removes the block and keeps outside text'
    Assert (-not (Test-Path $agents)) 'starter off deletes a file that held only the block'

    $extra = Join-Path $sb.Root 'extra.md'
    Write-File $extra "Extra rule.`n"
    Set-Config $sb @('claude') $true @($extra)
    Invoke-Kit $sb 'sync.ps1' | Out-Null
    $text = Get-Content $claude -Raw
    Assert ($text.IndexOf('Rule one.') -ge 0 -and $text.IndexOf('Rule one.') -lt $text.IndexOf('Extra rule.')) 'policy renders starter, then extra files'
} finally { Remove-Item -Recurse -Force $sb.Root }

# --- setup: non-interactive config output ------------------------------------------------------
$sb = New-Sandbox
try {
    $r = Invoke-Kit $sb 'setup.ps1' @('-Yes', '-Harnesses', 'claude,codex', '-StarterPolicy:$false', '-Hooks', 'contextGuard,keepWarm', '-HeavyJob', 'runner {cmd}', '-NoSync')
    $cfg = Read-Json $sb.Config
    Assert ($r.Code -eq 0 -and $cfg.kit -eq $sb.Kit) 'setup writes kit as the absolute path of its own repo'
    Assert (($cfg.harnesses -join ',') -eq 'claude,codex') 'setup writes the chosen harnesses'
    Assert ($cfg.policy.starter -eq $false -and $cfg.hooks.contextGuard -eq $true -and $cfg.hooks.keepWarm -eq $true -and $cfg.hooks.autoSync -eq $false) 'setup writes the policy and hook switches'
    Assert ($cfg.heavyJob -eq 'runner {cmd}' -and $cfg.browser.servers.Count -eq 0) 'setup writes heavyJob and a browser stub'
    $profilePath = Join-Path $sb.Home '.zekis-harness/profile.md'
    Assert ((Get-Content $profilePath -Raw) -match '## About' -and (Get-Content $profilePath -Raw) -match '## UI style' -and (Get-Content $profilePath -Raw) -match '## Browser accounts') 'setup creates profile.md with headings'
    Assert (-not (Test-Path (Join-Path $sb.Home '.claude'))) '-NoSync writes nothing into the agents'

    Write-File $profilePath "Mine.`n"
    $cfg.browser = @{ servers = @(@{ name = 'x'; profileDir = 'Default'; use = 'default' }) }
    Write-File $sb.Config ($cfg | ConvertTo-Json -Depth 6)
    Invoke-Kit $sb 'setup.ps1' @('-Yes', '-Harnesses', 'claude', '-StarterPolicy', '-NoHooks', '-HeavyJob', '', '-NoSync') | Out-Null
    $cfg = Read-Json $sb.Config
    Assert (($cfg.harnesses -join ',') -eq 'claude' -and $cfg.policy.starter -eq $true -and $cfg.hooks.contextGuard -eq $false -and $null -eq $cfg.heavyJob) 're-running setup updates answers'
    Assert ($cfg.browser.servers.Count -eq 1) 're-running setup keeps settings it was not asked about'
    Assert ((Get-Content $profilePath -Raw) -eq "Mine.`n") 're-running setup keeps an existing profile.md'

    $r = Invoke-Kit $sb 'setup.ps1' @('-Yes', '-Harnesses', 'claude', '-StarterPolicy')
    Assert ($r.Code -eq 0 -and (Get-Content (Join-Path $sb.Home '.claude/CLAUDE.md') -Raw) -match 'Rule one\.' -and (Test-Path (Join-Path $sb.Home '.claude/skills/alpha/SKILL.md'))) 'setup runs sync unless -NoSync'
    Assert (-not (Test-Path (Join-Path $sb.Home '.claude/settings.json'))) 'setup does not touch settings.json without -WireHooks'

    $r = Invoke-Kit $sb 'setup.ps1' @('-Yes', '-Harnesses', 'sparkle', '-NoSync')
    Assert ($r.Code -ne 0) 'setup rejects an unknown harness'
} finally { Remove-Item -Recurse -Force $sb.Root }

# --- setup: hook wiring ------------------------------------------------------------------------
$sb = New-Sandbox
try {
    $settings = Join-Path $sb.Home '.claude/settings.json'
    Write-File $settings '{ "model": "x", "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "echo mine" } ] } ] } }'
    $args1 = @('-Yes', '-Harnesses', 'claude', '-Hooks', 'contextGuard,keepWarm', '-WireHooks', '-NoSync')
    $r = Invoke-Kit $sb 'setup.ps1' $args1
    $json = Read-Json $settings
    $stopCommands = @($json.hooks.Stop | ForEach-Object { $_.hooks } | ForEach-Object { $_.command })
    Assert ($json.model -eq 'x' -and $stopCommands -contains 'echo mine' -and @($stopCommands | Where-Object { $_ -like '*keep-warm.sh*' }).Count -eq 1) 'wiring keeps existing settings and hooks and adds keep-warm'
    $keep = @($json.hooks.Stop | ForEach-Object { $_.hooks } | Where-Object { $_.command -like '*keep-warm.sh*' })[0]
    Assert ($keep.asyncRewake -eq $true -and $keep.timeout -eq 3100) 'keep-warm is wired with asyncRewake and its timeout'
    Assert ($json.hooks.PostToolUse.Count -eq 1 -and $json.hooks.UserPromptSubmit.Count -eq 1 -and -not $json.hooks.ContainsKey('SessionStart')) 'wiring adds only the selected hooks'
    Assert ((Test-Path "$settings.bak") -and (Get-Content "$settings.bak" -Raw) -match 'echo mine') 'wiring keeps a .bak of the previous settings'
    $before = Get-Content $settings -Raw
    Invoke-Kit $sb 'setup.ps1' $args1 | Out-Null
    Assert ((Get-Content $settings -Raw) -eq $before) 'wiring twice changes nothing'
    Assert ($r.Out -match 'Status line step') 'setup prints the status line step instead of doing it'
    Assert (-not $json.ContainsKey('statusLine')) 'setup does not set the status line'
} finally { Remove-Item -Recurse -Force $sb.Root }

# --- hooks (need bash) -------------------------------------------------------------------------
$bash = Get-Command bash -ErrorAction SilentlyContinue
if ($bash) {
    $root = New-TempDir
    try {
        $state = Join-Path $root 'state'
        New-Item -ItemType Directory $state | Out-Null
        Write-File (Join-Path $state 's1.tokens') '160000'
        $guard = Join-Path $repo 'hooks/context-guard.sh'
        $stdin = '{"session_id":"s1","hook_event_name":"PostToolUse","cwd":"/work"}'
        $env:AGENT_KIT_STATE = $state
        $env:ZEKIS_HARNESS_HOME = Join-Path $root 'zh'
        $out = $stdin | & bash $guard | Out-String
        Assert ($out -match 'additionalContext' -and $out -match 'Hand off at the next natural break') 'context-guard asks for a handoff past the soft threshold'
        Remove-Item (Join-Path $state 's1.warned')
        Write-File (Join-Path $root 'zh/config.json') '{ "hooks": { "contextGuard": false } }'
        $out = $stdin | & bash $guard | Out-String
        Assert (-not $out.Trim()) 'context-guard honors hooks.contextGuard false in config.json'
        Write-File (Join-Path $root 'zh/config.json') '{ "hooks": { "contextGuard": true } }'
        Write-File (Join-Path $state 's1.tokens') '1000'
        $out = $stdin | & bash $guard | Out-String
        Assert (-not $out.Trim()) 'context-guard stays quiet below the threshold'
    } finally {
        Remove-Item Env:AGENT_KIT_STATE, Env:ZEKIS_HARNESS_HOME -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $root
    }
} else { Write-Output 'skip hooks tests: bash not found' }

if ($failures) { Write-Output "$failures test(s) failed"; exit 1 }
Write-Output 'all tests passed'
