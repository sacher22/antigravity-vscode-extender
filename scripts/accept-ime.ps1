Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class InputProbe {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint t);
 [DllImport("user32.dll")] public static extern int GetKeyboardLayoutList(int n, [Out] IntPtr[] a);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("imm32.dll")] public static extern IntPtr ImmGetContext(IntPtr h);
 [DllImport("imm32.dll")] public static extern bool ImmSetOpenStatus(IntPtr h,bool open);
 [DllImport("imm32.dll")] public static extern bool ImmReleaseContext(IntPtr h,IntPtr c);
}
'@
$shell=New-Object -ComObject WScript.Shell
[void]$shell.AppActivate('[Extension Development Host]')
Start-Sleep -Milliseconds 300
$h=[InputProbe]::GetForegroundWindow(); $pidWindow=[uint32]0; $thread=[InputProbe]::GetWindowThreadProcessId($h,[ref]$pidWindow)
$p=Get-Process -Id $pidWindow
Write-Output ($p.ProcessName + ':' + $p.MainWindowTitle)
if ($p.ProcessName -ne 'Code' -or $p.MainWindowTitle -notlike '*Extension Development Host*') { throw 'Test development window is not foreground' }
$old=[InputProbe]::GetKeyboardLayout($thread);$n=[InputProbe]::GetKeyboardLayoutList(0,$null);$a=New-Object IntPtr[] $n;[void][InputProbe]::GetKeyboardLayoutList($n,$a)
$ch=$a | Where-Object { ($_.ToInt64() -band 65535) -eq 2052 } | Select-Object -First 1
if(!$ch){throw 'No loaded Chinese keyboard layout'}
try {
 [void][InputProbe]::PostMessage($h,0x50,[IntPtr]::Zero,$ch);Start-Sleep -Milliseconds 300
 [System.Windows.Forms.SendKeys]::SendWait('nihao');Start-Sleep -Milliseconds 300
 if ($args[0] -eq 'space') { [System.Windows.Forms.SendKeys]::SendWait(' ') } else { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') };Start-Sleep -Milliseconds 200
 Write-Output 'OS keyboard nihao + Enter sent to the development window'
} finally { [void][InputProbe]::PostMessage($h,0x50,[IntPtr]::Zero,$old) }
