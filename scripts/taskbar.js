// Handle of the Windows taskbar: a real window with real buttons that tests can read without focusing anything.

const { execFileSync } = require('child_process');

function taskbarHandle() {
  const script = 'Add-Type -Namespace W -Name U -MemberDefinition \'[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern System.IntPtr FindWindow(string c, string t);\'; [W.U]::FindWindow("Shell_TrayWnd", $null).ToInt64()';
  return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }).toString().trim());
}

module.exports = { taskbarHandle };
