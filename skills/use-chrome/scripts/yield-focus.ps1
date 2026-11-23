# Called by the patched @playwright/mcp right after the extension connects.
# If the foreground window is the Chrome window that just opened the
# extension's connect page ("Welcome"), minimize it so Windows hands focus
# back to whatever the user was using, then restore it at the bottom of the
# z-order without activating it, so agent pages keep a real viewport.
# Never touches any other window.
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class YieldFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
for ($i = 0; $i -lt 10; $i++) {
  $h = [YieldFocus]::GetForegroundWindow()
  $sb = New-Object Text.StringBuilder 512
  [void][YieldFocus]::GetWindowText($h, $sb, 512)
  $procId = 0; [void][YieldFocus]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
  if ($name -eq 'chrome' -and $sb.ToString() -like 'Welcome - *') {
    [void][YieldFocus]::ShowWindow($h, 6)  # SW_MINIMIZE: activates the next window in z-order
    Start-Sleep -Milliseconds 300
    [void][YieldFocus]::ShowWindow($h, 4)  # SW_SHOWNOACTIVATE
    [void][YieldFocus]::SetWindowPos($h, [IntPtr]1, 0, 0, 0, 0, 0x13)  # HWND_BOTTOM; NOSIZE|NOMOVE|NOACTIVATE
    exit 0
  }
  Start-Sleep -Milliseconds 200
}
