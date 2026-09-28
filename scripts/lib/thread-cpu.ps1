# PERF-CPU helper (keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less UTF-8 as the ANSI code page,
# and multi-byte comments can swallow line breaks, silently turning the param() line into a comment).
# Lists per-thread CPU seconds and the thread description Chrome sets (CrRendererMain, CrGpuMain, DedicatedWorker thread ...).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File thread-cpu.ps1 -Pids 123,456
# Output per line: pid<TAB>tid<TAB>seconds<TAB>name
param([string]$Pids)
if (-not ('PerfCpu.Th' -as [type])) {
  Add-Type -Namespace PerfCpu -Name Th -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern System.IntPtr OpenThread(int access, bool inherit, int tid);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(System.IntPtr h);
[DllImport("kernel32.dll")] public static extern int GetThreadDescription(System.IntPtr h, out System.IntPtr desc);
[DllImport("kernel32.dll")] public static extern System.IntPtr LocalFree(System.IntPtr p);
public static string Name(int tid) {
  System.IntPtr h = OpenThread(0x1000, false, tid);
  if (h == System.IntPtr.Zero) return "";
  System.IntPtr p; string s = "";
  if (GetThreadDescription(h, out p) >= 0 && p != System.IntPtr.Zero) { s = System.Runtime.InteropServices.Marshal.PtrToStringUni(p); LocalFree(p); }
  CloseHandle(h);
  return s;
}
'@
}
foreach ($p in ($Pids -split ',' | ForEach-Object { [int]$_ })) {
  $pr = Get-Process -Id $p -ErrorAction SilentlyContinue
  if (-not $pr) { continue }
  foreach ($t in $pr.Threads) {
    $n = [PerfCpu.Th]::Name($t.Id)
    "$p`t$($t.Id)`t$($t.TotalProcessorTime.TotalSeconds)`t$n"
  }
}
