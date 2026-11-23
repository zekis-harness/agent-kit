$ErrorActionPreference = 'Stop'
$kit = Split-Path $PSScriptRoot -Parent
$root = Join-Path ([IO.Path]::GetTempPath()) ('kit-batch-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory $root
$failures = 0
function Assert([bool]$ok, [string]$name) {
    if ($ok) { Write-Output "ok   should $name" } else { Write-Output "FAIL should $name"; $script:failures++ }
}
function Run-Batch([string[]]$extra = @()) {
    & pwsh -NoProfile -File (Join-Path $kit 'bin\batch.ps1') -Manifest (Join-Path $root 'queue.json') `
        -StateDirectory (Join-Path $root 'state') -TimeoutMinutes 1 @extra 2>&1 | Out-Null
}
function State { Get-Content (Join-Path $root 'state\state.json') -Raw | ConvertFrom-Json }
function Ledger { @(Get-Content (Join-Path $root 'state\synthetic-ledger.jsonl') | ForEach-Object { $_ | ConvertFrom-Json }) }
$savedStub = $env:AGENT_KIT_EXE_COPILOT
try {
    $stub = Join-Path $root 'stub.ps1'
    Set-Content $stub @'
$prompt = @($input) -join "`n"
if (-not $env:BATCH_TEST_BROKEN) { Set-Content 'result.txt' 'correct' }
$sid = [guid]::NewGuid().ToString()
$dir = Join-Path $env:COPILOT_HOME "session-state/$sid"
$null = New-Item -ItemType Directory -Force $dir
@{type='session.shutdown';data=@{accountingSnapshot=@{totalNanoAiu=1000000000;modelMetrics=@{test=@{usage=@{inputTokens=120;outputTokens=12;cacheReadTokens=0;cacheWriteTokens=0}}}}}} | ConvertTo-Json -Depth 10 -Compress | Set-Content (Join-Path $dir 'events.jsonl')
@{type='assistant.message';data=@{content="STATUS: blocked`nCHANGED: result.txt`nNOT VERIFIED: runtime; operator checks independently"}} | ConvertTo-Json -Compress
@{type='result';sessionId=$sid} | ConvertTo-Json -Compress
exit 0
'@
    $env:AGENT_KIT_EXE_COPILOT = $stub
    $checker = Join-Path $root 'check.mjs'
    Set-Content $checker "import {readFileSync} from 'node:fs'; if(readFileSync(process.argv[2],'utf8').trim()!=='correct') process.exit(1);"
    $items = @(foreach ($id in 'one', 'two', 'three') {
        $cwd = Join-Path $root $id
        $null = New-Item -ItemType Directory $cwd
        Set-Content (Join-Path $root "$id.md") 'Write result.txt containing correct.'
        @{ id = $id; cwd = $id; brief = "$id.md"; acceptance = @{ exe = 'node'; args = @($checker, (Join-Path $cwd 'result.txt')) } }
    })
    @{purpose='synthetic-eval';items=$items} | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $root 'queue.json')
    Run-Batch
    Assert ($LASTEXITCODE -eq 0 -and @((State).items | Where-Object status -eq 'accepted').Count -eq 3) 'accept three independently checked items'
    Assert (@(Ledger | Where-Object { $_.type -eq 'dispatch' -and $_.status -eq 'blocked' }).Count -eq 3) 'base acceptance on actual checks instead of worker self-assessment'
    $runs = @(Ledger | Where-Object type -eq 'dispatch')
    Assert (@($runs.session_id | Select-Object -Unique).Count -eq 3) 'use three distinct sessions'
    Assert (@(Ledger | Where-Object type -eq 'verdict').Count -eq 3) 'record one verdict per item'
    Run-Batch
    Assert (@(Ledger | Where-Object type -eq 'dispatch').Count -eq 3) 'skip accepted items on resume'

    $statePath = Join-Path $root 'state\state.json'
    $state = State
    $state.items[0].status = 'running'
    $state.items[0].attempts[0].run = $null
    $state | ConvertTo-Json -Depth 25 | Set-Content $statePath
    Run-Batch
    Assert (@(Ledger | Where-Object type -eq 'dispatch').Count -eq 3 -and (State).items[0].status -eq 'accepted') 'reconcile crash after ledger append without redispatch'
    Assert (@(Ledger | Where-Object type -eq 'verdict').Count -eq 3) 'avoid duplicate verdict on reconciliation'
    $state = State
    $state.items[0].status = 'validated'
    $state | ConvertTo-Json -Depth 25 | Set-Content $statePath
    Run-Batch
    Assert (@(Ledger | Where-Object type -eq 'verdict').Count -eq 3 -and (State).items[0].status -eq 'accepted') 'recover crash between verdict append and final state'
    Set-Content (Join-Path $root 'one\result.txt') 'wrong'
    Run-Batch @('-RecheckItem', 'one')
    Assert ((State).items[0].status -eq 'rejected' -and @(Ledger | Where-Object type -eq 'verdict').Count -eq 4) 'append a changed independent verdict without erasing history'
    Set-Content (Join-Path $root 'one\result.txt') 'correct'
    Run-Batch @('-RecheckItem', 'one')
    Assert ((State).items[0].status -eq 'accepted' -and @(Ledger | Where-Object type -eq 'dispatch').Count -eq 3) 'recheck without a new dispatch'

    $state = State
    $state.items[0].status = 'running'
    $state.items[0].attempts[0].report = Join-Path $root 'missing.report.md'
    $state | ConvertTo-Json -Depth 25 | Set-Content $statePath
    Run-Batch
    Assert ((State).items[0].status -eq 'interrupted') 'mark unknown dispatch interrupted rather than repeating'
    Run-Batch @('-RetryItem', 'one')
    Assert ($LASTEXITCODE -ne 0 -and (State).items[0].attempts.Count -eq 1) 'require orphan confirmation for interrupted retry'
    $env:BATCH_TEST_BROKEN = '1'
    Remove-Item (Join-Path $root 'one\result.txt')
    Run-Batch @('-RetryItem', 'one', '-OrphansStopped')
    Assert ((State).items[0].status -eq 'rejected') 'reject a done report when independent acceptance fails'
    Assert ((State).items[0].attempts[-1].outcome -eq 'rework') 'account for failed acceptance as rework'
    Run-Batch @('-RetryItem', 'one')
    Assert ($LASTEXITCODE -ne 0 -and (State).items[0].attempts.Count -eq 2) 'enforce bounded explicit retries'
    Remove-Item Env:BATCH_TEST_BROKEN

    $lock = [IO.File]::Open((Join-Path $root 'state\queue.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    try { Run-Batch; Assert ($LASTEXITCODE -ne 0) 'reject concurrent access to the same queue' } finally { $lock.Dispose() }
    Run-Batch @('-Tier', 'chore')
    Assert ($LASTEXITCODE -ne 0) 'reject changed routing on resume'
    Add-Content (Join-Path $root 'queue.json') ' '
    Run-Batch
    Assert ($LASTEXITCODE -ne 0) 'pin the manifest content for resume'

    $ledger = Join-Path $root 'state\synthetic-ledger.jsonl'
    @{type='dispatch';run='unpriced';harness='test';tier='build';model='test';duration_s=1;cost_usd=$null} | ConvertTo-Json -Compress | Add-Content $ledger
    & pwsh -NoProfile -File (Join-Path $kit 'bin\verdict.ps1') -Run unpriced -Outcome accepted -Ledger $ledger | Out-Null
    $rows = (& pwsh -NoProfile -File (Join-Path $kit 'bin\report.ps1') -Ledger $ledger -Json) -join "`n" | ConvertFrom-Json
    $row = $rows | Where-Object harness -eq 'test'
    Assert ($null -eq $row.cost_usd -and $null -eq $row.usd_per_accepted -and $row.unpriced -eq 1) 'retain unknown costs instead of reporting free accepted work'

    $timeoutManifest = Join-Path $root 'timeout.json'
    $sleepCheck = Join-Path $root 'sleep.mjs'
    Set-Content $sleepCheck 'setTimeout(() => {}, 120000);'
    @{items=@(@{id='slow';cwd=(Join-Path $root 'three');brief=(Join-Path $root 'three.md');acceptance=@{exe='node';args=@($sleepCheck)}})} |
        ConvertTo-Json -Depth 7 | Set-Content $timeoutManifest
    $timeoutState = Join-Path $root 'timeout-state'
    $null = New-Item -ItemType Directory $timeoutState
    Set-Content (Join-Path $timeoutState 'queue.pause') ''
    & pwsh -NoProfile -File (Join-Path $kit 'bin\batch.ps1') -Manifest $timeoutManifest -StateDirectory $timeoutState | Out-Null
    $paused = Get-Content (Join-Path $timeoutState 'state.json') -Raw | ConvertFrom-Json
    Assert ($paused.items[0].status -eq 'pending' -and $paused.items[0].attempts.Count -eq 0) 'pause pending items without launching a worker'
    Remove-Item (Join-Path $timeoutState 'queue.pause')
    & pwsh -NoProfile -File (Join-Path $kit 'bin\batch.ps1') -Manifest $timeoutManifest -StateDirectory $timeoutState -AcceptanceTimeoutSeconds 1 | Out-Null
    $timed = Get-Content (Join-Path $timeoutState 'state.json') -Raw | ConvertFrom-Json
    Assert ($timed.items[0].status -eq 'rejected' -and $timed.items[0].attempts[0].acceptance_exit -eq 124) 'bound acceptance execution and reject timed-out checks'
    Assert ((Test-Path (Join-Path $timeoutState 'batch-ledger.jsonl')) -and $timed.purpose -eq 'batch') 'keep generic batches distinct from synthetic evaluation records'
} finally {
    $env:AGENT_KIT_EXE_COPILOT = $savedStub
    Remove-Item Env:BATCH_TEST_BROKEN -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force
}
exit $failures
