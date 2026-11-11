# 把指定标题的窗口压到 Z 序最底层（不最小化，点任务栏仍可正常置顶）
param([string]$TitlePart = "Chromium")

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinZ {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const int SW_SHOWNOACTIVATE = 4;
}
"@

$procs = Get-Process | Where-Object { $_.MainWindowTitle -like "*$TitlePart*" }
if (-not $procs) { Write-Output "no window matching '$TitlePart'"; exit 1 }

foreach ($p in $procs) {
  $h = $p.MainWindowHandle
  if ($h -eq [IntPtr]::Zero) { continue }
  [WinZ]::ShowWindow($h, [WinZ]::SW_SHOWNOACTIVATE) | Out-Null
  [WinZ]::SetWindowPos($h, [WinZ]::HWND_BOTTOM, 0, 0, 0, 0, [WinZ]::SWP_NOSIZE -bor [WinZ]::SWP_NOMOVE -bor [WinZ]::SWP_NOACTIVATE) | Out-Null
  Write-Output "sent to bottom: $($p.Id) $($p.MainWindowTitle)"
}
