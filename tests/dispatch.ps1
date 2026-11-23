$ErrorActionPreference = 'Stop'
$kit = Split-Path $PSScriptRoot -Parent
$failures = 0

function Assert([bool]$condition, [string]$name) {
    if ($condition) { Write-Output "ok   $name" }
    else { Write-Output "FAIL $name"; $script:failures++ }
}

$dispatch = Join-Path $kit 'bin/dispatch.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('agent-kit-dispatch-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $root | Out-Null
$env:AGENT_KIT_LEDGER = Join-Path $root 'ledger.jsonl'
$env:AGENT_KIT_WORKER_HOME = Join-Path $root 'worker-home'
# CI runners have no git identity; land.ps1 commits inside the worktree.
foreach ($v in 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME') { Set-Item "Env:$v" 'agent-kit-test' }
foreach ($v in 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL') { Set-Item "Env:$v" 'test@example.invalid' }

function Read-Ledger { @(Get-Content $env:AGENT_KIT_LEDGER -ErrorAction SilentlyContinue | ForEach-Object { $_ | ConvertFrom-Json }) }
function Invoke-Dispatch([string[]]$extra) { (& pwsh -NoProfile -File $dispatch @extra) -join "`n" }

# Fake copilot: records its prompt and COPILOT_HOME, prints JSONL like the real CLI and writes the
# session.shutdown accounting event under COPILOT_HOME.
$copilotStub = Join-Path $root 'copilot-stub.ps1'
Set-Content $copilotStub @'
$prompt = @($input) -join "`n"
Set-Content (Join-Path $env:STUB_OUT 'prompt.txt') $prompt
Set-Content (Join-Path $env:STUB_OUT 'home.txt') $env:COPILOT_HOME
if ($env:STUB_TOUCH) { Set-Content (Join-Path (Get-Location) $env:STUB_TOUCH) 'worker output' }
$sid = 'sess-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
$dir = Join-Path $env:COPILOT_HOME "session-state/$sid"
New-Item -ItemType Directory -Force $dir | Out-Null
$usage = @{ inputTokens = 1000; outputTokens = 50; cacheReadTokens = 600; cacheWriteTokens = 400 }
$shutdown = @{ type = 'session.shutdown'; data = @{ accountingSnapshot = @{ totalNanoAiu = 2500000000; modelMetrics = @{ 'gpt-6.1-sol' = @{ usage = $usage } } } } }
Set-Content (Join-Path $dir 'events.jsonl') ($shutdown | ConvertTo-Json -Depth 8 -Compress)
@{ type = 'assistant.message'; data = @{ content = "STATUS: done`nCHANGED: none`nVERIFIED: stub -> ok" } } | ConvertTo-Json -Compress
@{ type = 'session.usage_checkpoint'; data = @{ totalNanoAiu = 2400000000 } } | ConvertTo-Json -Compress
@{ type = 'result'; sessionId = $sid; exitCode = 0 } | ConvertTo-Json -Compress
exit 0
'@
$sleepStub = Join-Path $root 'sleep-stub.ps1'
Set-Content $sleepStub @'
$null = @($input)
$p = Start-Process pwsh -ArgumentList '-NoProfile', '-Command', 'Start-Sleep 120' -PassThru -NoNewWindow
Set-Content (Join-Path $env:STUB_OUT 'child.pid') $p.Id
$p.WaitForExit()
'@
$claudeStub = Join-Path $root 'claude-stub.ps1'
Set-Content $claudeStub @'
$null = @($input)
@{ type = 'result'; result = "STATUS: done`nCHANGED: none"; session_id = 'c1'; total_cost_usd = 0.12
   usage = @{ input_tokens = 10; output_tokens = 20; cache_read_input_tokens = 300; cache_creation_input_tokens = 40 } } | ConvertTo-Json -Compress
exit 0
'@
$env:STUB_OUT = $root
$codexStub = Join-Path $root 'codex-stub.ps1'
Set-Content $codexStub @'
if ($args -contains '--version') {
    if ($env:STUB_CODEX_OLD) { 'codex-cli 0.166.0' } else { 'codex-cli 0.167.0' }
    exit 0
}
$kind = if ($args -contains 'sandbox') { 'sandbox' } else { 'exec' }
@{ argv = @($args); cwd = (Get-Location).Path; home = $env:CODEX_HOME } |
    ConvertTo-Json -Depth 4 -Compress | Add-Content (Join-Path $env:STUB_OUT 'codex-calls.jsonl')
if ($kind -eq 'sandbox') {
    if ($env:STUB_SANDBOX_FAIL) { [Console]::Error.WriteLine('MXC unavailable'); exit 1 }
    if (-not $env:STUB_SANDBOX_NO_WRITE) {
        $index = [array]::IndexOf($args, '-EncodedCommand')
        $command = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($args[$index + 1]))
        if ($command -match "WriteAllText\('((?:''|[^'])*)', '([a-f0-9]+)'\)") {
            [IO.File]::WriteAllText($Matches[1].Replace("''", "'"), $Matches[2])
        } else { throw 'Unexpected probe command' }
    }
    exit 0
}
$null = @($input)
$index = [array]::IndexOf($args, '-o')
[IO.File]::WriteAllText($args[$index + 1], "STATUS: done`nCHANGED: none")
@{ type = 'turn.completed'; usage = @{ input_tokens = 10; output_tokens = 2; cached_input_tokens = 5 } } | ConvertTo-Json -Compress
exit 0
'@

try {
    $brief = Join-Path $root 'task.md'
    Set-Content $brief '# Task: x'

    $out = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'copilot', '-DryRun')
    Assert ($out.Contains('--assisted-approval') -and $out.Contains('shell(git push)') -and -not $out.Contains('--allow-all')) 'copilot defaults to safe mode: assisted approval, no push, no allow-all'
    Assert ($out.Contains("COPILOT_HOME: $(Join-Path $env:AGENT_KIT_WORKER_HOME 'copilot')")) 'copilot workers get their own COPILOT_HOME'
    Assert (-not (Test-Path $env:AGENT_KIT_WORKER_HOME) -and -not (Test-Path $env:AGENT_KIT_LEDGER)) 'dry run writes nothing'
    $out = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'claude', '-DryRun')
    Assert ($out.Contains('--permission-mode auto') -and -not $out.Contains('skip-permissions')) 'claude defaults to auto mode, not bypass'
    $out = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'codex', '-DryRun')
    $safePolicy = if ($IsWindows) { "windows.sandbox='mxc'" } else { '-s workspace-write' }
    Assert ($out.Contains($safePolicy) -and -not $out.Contains('bypass')) 'codex defaults to a native workspace-write sandbox'
    $out = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'codex', '-Mode', 'read', '-DryRun')
    Assert ($out.Contains('-s read-only') -and -not $out.Contains('windows.sandbox')) 'codex read mode keeps its read-only policy'
    $out = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'codex', '-Mode', 'bypass', '-DryRun')
    Assert ($out.Contains('--dangerously-bypass-approvals-and-sandbox') -and -not $out.Contains('windows.sandbox')) 'codex bypass stays explicit'
    $out = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'copilot', '-Mode', 'bypass', '-DryRun')
    Assert ($out.Contains('--allow-all')) 'bypass mode is still available'
    $out = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'copilot', '-MaxCredits', '5', '-DryRun')
    Assert ($out.Contains('--max-ai-credits 5')) 'copilot credit cap is passed through'

    $env:AGENT_KIT_EXE_CODEX = $codexStub
    $env:CODEX_HOME = Join-Path $root 'existing codex home'
    $codexHome = $env:CODEX_HOME
    $null = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'codex', '-Cwd', $root)
    Assert ($LASTEXITCODE -eq 0) 'codex safe worker runs after a successful prerequisite probe'
    $calls = @(Get-Content (Join-Path $root 'codex-calls.jsonl') | ConvertFrom-Json)
    $execCall = $calls[-1]
    Assert ($execCall.argv[0] -eq 'exec' -and $execCall.argv -contains '--ignore-user-config' -and $execCall.argv -contains '--ephemeral') 'codex keeps isolated config and ephemeral execution'
    Assert ($execCall.cwd -eq $root -and $execCall.argv[[array]::IndexOf($execCall.argv, '-C') + 1] -eq $root -and $execCall.home -eq $codexHome) 'codex cwd and -C agree and CODEX_HOME auth location is preserved'
    if ($IsWindows) {
        . (Join-Path $kit 'bin/codex-sandbox.ps1')
        $policy = @(Get-CodexWindowsSandboxArgs)
        $sandboxCall = $calls[0]
        Assert ($sandboxCall.argv -contains 'sandbox' -and $sandboxCall.cwd -eq $root) 'Windows safe mode probes the real worker directory before exec'
        $samePolicy = $true
        foreach ($value in $policy | Where-Object { $_ -ne '-c' }) {
            if ($execCall.argv -notcontains $value -or $sandboxCall.argv -notcontains $value) { $samePolicy = $false }
        }
        Assert $samePolicy 'probe and worker share literal TOML, MXC, never-approve, scoped roots and offline policy'
        foreach ($flag in 'STUB_SANDBOX_FAIL', 'STUB_SANDBOX_NO_WRITE', 'STUB_CODEX_OLD') {
            $before = @(Get-Content (Join-Path $root 'codex-calls.jsonl') | ConvertFrom-Json | Where-Object { $_.argv[0] -eq 'exec' }).Count
            Set-Item "Env:$flag" '1'
            $null = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'codex', '-Cwd', $root) 2>$null
            Assert ($LASTEXITCODE -ne 0) "codex fails visibly for $flag"
            $failedRun = Read-Ledger | Where-Object type -eq 'dispatch' | Select-Object -Last 1
            Assert ($failedRun.status -eq 'failed' -and $failedRun.exit -eq 1) "codex records a failed run for $flag"
            $after = @(Get-Content (Join-Path $root 'codex-calls.jsonl') | ConvertFrom-Json | Where-Object { $_.argv[0] -eq 'exec' }).Count
            Assert ($after -eq $before) "codex does not call the model after $flag"
            Remove-Item "Env:$flag"
        }
        Assert (-not (Get-ChildItem $root -Filter '.agent-kit-sandbox-*' -Force)) 'sandbox prerequisite probes clean up markers'
    }

    $env:AGENT_KIT_EXE_COPILOT = $copilotStub
    $out = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'copilot', '-Cwd', $root)
    $ledger = Read-Ledger
    $run = $ledger | Where-Object type -eq 'dispatch' | Select-Object -Last 1
    Assert ($LASTEXITCODE -eq 0 -and $out.StartsWith('STATUS: done')) 'copilot run prints the final message as the report'
    Assert ((Get-Content (Join-Path $root 'home.txt') -Raw).Trim() -eq (Join-Path $env:AGENT_KIT_WORKER_HOME 'copilot')) 'copilot worker ran with the isolated home'
    Assert ((Get-Content (Join-Path $root 'prompt.txt') -Raw).Contains('You are a worker, not the orchestrator')) 'worker prompt carries the orchestrator-rule override'
    Assert ($run.cost_usd -eq 0.025 -and $run.input_tokens -eq 1000 -and $run.cache_read_tokens -eq 600 -and $run.status -eq 'done') 'ledger records cost and tokens from the session accounting'
    Assert ($out.Contains("run=$($run.run)") -and $out.Contains('cost=$0.025')) 'footer shows run id and cost'

    & pwsh -NoProfile -File (Join-Path $kit 'bin/verdict.ps1') -Run $run.run -Outcome accepted | Out-Null
    $rows = (& pwsh -NoProfile -File (Join-Path $kit 'bin/report.ps1') -Json) -join "`n" | ConvertFrom-Json
    Assert ($rows.accepted -eq 1 -and $rows.usd_per_accepted -eq 0.025) 'report computes cost per accepted task'

    $env:AGENT_KIT_EXE_CLAUDE = $claudeStub
    $null = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'claude', '-Cwd', $root)
    $run = Read-Ledger | Where-Object type -eq 'dispatch' | Select-Object -Last 1
    Assert ($run.harness -eq 'claude' -and $run.cost_usd -eq 0.12 -and $run.cache_write_tokens -eq 40 -and $run.status -eq 'done') 'claude JSON result is parsed into report and ledger'

    $env:AGENT_KIT_EXE_COPILOT = $sleepStub
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $out = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'copilot', '-Cwd', $root, '-TimeoutMinutes', '0.05')
    $code = $LASTEXITCODE
    $sw.Stop()
    $childPid = [int](Get-Content (Join-Path $root 'child.pid') -Raw)
    Start-Sleep -Milliseconds 300
    Assert ($code -eq 124 -and $out.Contains('timed out') -and $sw.Elapsed.TotalSeconds -lt 60) 'timeout stops the worker and reports failure'
    Assert (-not (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) 'timeout kills the worker process tree'
    Assert ((Read-Ledger | Where-Object type -eq 'dispatch' | Select-Object -Last 1).timed_out) 'ledger marks the timeout'

    $repo = Join-Path $root 'repo'
    git init -q $repo
    git -C $repo -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
    if ($IsWindows) {
        $out = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'codex', '-Cwd', $repo, '-Worktree')
        $codexRun = Read-Ledger | Where-Object type -eq 'dispatch' | Select-Object -Last 1
        $calls = @(Get-Content (Join-Path $root 'codex-calls.jsonl') | ConvertFrom-Json)
        Assert ($LASTEXITCODE -eq 0 -and $calls[-1].cwd -eq $codexRun.cwd -and $calls[-2].cwd -eq $codexRun.cwd -and $codexRun.cwd -ne $repo) 'codex probes and runs in the created worktree, not the source checkout'
        & pwsh -NoProfile -File (Join-Path $kit 'bin/land.ps1') -Worktree $codexRun.cwd -Discard | Out-Null
    }
    $env:AGENT_KIT_EXE_COPILOT = $copilotStub
    $env:STUB_TOUCH = 'from-worker.txt'
    $out = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'copilot', '-Cwd', $repo, '-Worktree')
    $wt = ([regex]::Match($out, 'WORKTREE: (\S+)')).Groups[1].Value
    Assert ($wt -and (Test-Path (Join-Path $wt 'from-worker.txt')) -and -not (git -C $repo status --porcelain)) 'worktree run edits the worktree, not the main checkout'
    Assert ((git -C $repo branch --list 'agent/*') -match 'agent/task-') 'worktree run creates an agent/ branch'
    & pwsh -NoProfile -File (Join-Path $kit 'bin/land.ps1') -Worktree $wt -Accept | Out-Null
    Assert ((git -C $repo diff --cached --name-only) -contains 'from-worker.txt' -and -not (Test-Path $wt) -and -not (git -C $repo branch --list 'agent/*')) 'land -Accept stages the work and removes worktree and branch'
    git -C $repo -c user.name=t -c user.email=t@t commit -q -m landed
    $out = Invoke-Dispatch @('-Brief', $brief, '-Harness', 'copilot', '-Cwd', $repo, '-Worktree')
    $wt = ([regex]::Match($out, 'WORKTREE: (\S+)')).Groups[1].Value
    & pwsh -NoProfile -File (Join-Path $kit 'bin/land.ps1') -Worktree $wt -Discard | Out-Null
    Assert (-not (Test-Path $wt) -and -not (git -C $repo branch --list 'agent/*') -and -not (git -C $repo status --porcelain)) 'land -Discard drops the work'

    $env:AGENT_KIT_EXE_CLAUDE = $claudeStub
    $probeOut = Join-Path $root 'probe.json'
    & pwsh -NoProfile -File (Join-Path $kit 'bin/probe.ps1') -Harness 'claude,nothing' -Out $probeOut | Out-Null
    $probed = @(Get-Content $probeOut -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json)
    Assert ($LASTEXITCODE -eq 0 -and $probed.Count -eq 3 -and -not ($probed | Where-Object { -not $_.ok })) 'probe writes a result for every claude tier'

    $contract = Get-Content (Join-Path $kit 'worker-contract.md') -Raw
    Assert (($contract -match 'finish the loop') -and ($contract -match 'dispatch\.ps1') -and ($contract -match 'continue\.ps1') -and ($contract -match 'heavy-job')) 'contract names every orchestrator-only rule it overrides'
} finally {
    Remove-Item Env:AGENT_KIT_LEDGER, Env:AGENT_KIT_WORKER_HOME, Env:AGENT_KIT_EXE_COPILOT, Env:AGENT_KIT_EXE_CLAUDE, Env:AGENT_KIT_EXE_CODEX, Env:STUB_OUT, Env:STUB_TOUCH, Env:STUB_SANDBOX_FAIL, Env:STUB_SANDBOX_NO_WRITE, Env:STUB_CODEX_OLD, Env:CODEX_HOME -ErrorAction SilentlyContinue
    Remove-Item Env:GIT_AUTHOR_NAME, Env:GIT_COMMITTER_NAME, Env:GIT_AUTHOR_EMAIL, Env:GIT_COMMITTER_EMAIL -ErrorAction SilentlyContinue
    Get-ChildItem $root -Directory -Filter '*.agents' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
exit $failures
