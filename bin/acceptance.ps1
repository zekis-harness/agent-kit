function Invoke-IndependentAcceptance([hashtable]$Check) {
    $process = [Diagnostics.Process]::new()
    try {
        $process.StartInfo.FileName = (Get-Command $Check.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $process.StartInfo.WorkingDirectory = $Check.cwd
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        foreach ($arg in $Check.args) { $process.StartInfo.ArgumentList.Add([string]$arg) }
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($Check.timeoutSeconds * 1000)) {
            $process.Kill($true)
            $process.WaitForExit()
            $code = 124
        } else { $code = $process.ExitCode }
        [IO.File]::WriteAllText($Check.log, $stdout.GetAwaiter().GetResult() + "`n" + $stderr.GetAwaiter().GetResult())
        return $code
    } finally { $process.Dispose() }
}
