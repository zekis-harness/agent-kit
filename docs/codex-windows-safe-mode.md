# Windows Codex safe mode

This applies to Windows only. On macOS and Linux, `-Harness codex -Mode safe` uses Codex's own `-s workspace-write` sandbox and `bin/codex-sandbox.ps1` is not loaded.

`bin/dispatch.ps1 -Harness codex -Mode safe` requires official Codex CLI 0.167.0
or newer and Windows MXC support. It selects `windows.sandbox='mxc'` explicitly,
not the weaker unelevated implementation. If MXC is unavailable or prohibited by
managed policy, dispatch fails before making a model call. It does not provision
accounts, request elevation, change saved configuration, or fall back to bypass.

The previous `--ignore-user-config -s workspace-write` invocation discarded the
user's Windows sandbox selection without supplying its own. Workspace permissions
alone do not select a native Windows sandbox. The new invocation uses an explicit
workspace profile, preserves Codex's protected paths (including `.git`), removes
the default writable temporary directories, disables sandbox network access, and
never allows approval-based escalation. The entire profile catalog is supplied on
the command line so ambient profiles cannot add writable roots. TOML literal
strings survive both native executables and npm's Windows `.cmd` shim.

Before model execution, the official `codex sandbox` command creates a unique
marker in the actual worker directory. Dispatch verifies its contents and removes
it. This works without model authentication. Both the probe and worker receive the
same explicit policy. `CODEX_HOME` is unchanged for authentication; model execution
continues to ignore user config and use an ephemeral session. Managed requirements
remain enforced. Read-only, explicit bypass, and non-Windows invocations retain
their previous arguments.

Run the opt-in live boundary test against a real installed CLI:

```powershell
pwsh -NoProfile -File tests/codex-sandbox.ps1 -Exe 'C:\path\to\codex.exe'
```

For an npm `.cmd` shim, pass `-Exe 'C:\path\to\codex.cmd'` and
`-NativeExe 'C:\path\to\codex.exe'` from the same official installation.
The test uses disposable fixtures and an isolated `CODEX_HOME`. It verifies real
workspace file creation (including the official native `apply_patch` helper),
out-of-workspace patch, junction escape and `.git` write denial, read-only
denial, local push denial, direct outbound TCP denial after establishing a
reachable unsandboxed baseline, and host-loopback denial. A failed prerequisite is an error, not a skipped
or successful test. No credentials or model calls are needed. This local probe
does not claim an authenticated model turn was exercised.

See the official [Windows sandbox documentation](https://developers.openai.com/codex/windows/)
for host requirements and administrator-managed restrictions. On unsupported
hosts, update Windows or use a separately supported execution environment rather
than replacing safe mode with bypass.
