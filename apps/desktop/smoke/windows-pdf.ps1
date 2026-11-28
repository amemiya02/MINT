param([int]$AppProcess, [ValidateSet('Export','Save')] [string]$Action)
$ErrorActionPreference = 'Stop'
# Exercise MINT's native File menu and the standard Save dialog without moving
# a shared cursor or depending on screen coordinates on the hosted runner.
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PdfDialog {
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr menu, int index);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
    [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu, int index);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr menu, uint index, StringBuilder text, int length, uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    public static IntPtr NextWindow(IntPtr after, bool save) { return FindWindowEx(IntPtr.Zero,after,save ? "#32770" : null,save ? "Save PDF" : null); }
    public static int ExportCommand(IntPtr menu) {
        for (int i=0; i<GetMenuItemCount(menu); i++) {
            var title = new StringBuilder(256);
            GetMenuString(menu, (uint)i, title, title.Capacity, 0x400);
            if (title.ToString().Replace("&","").StartsWith("Export as PDF")) return (int)GetMenuItemID(menu,i);
            var child=GetSubMenu(menu,i);
            if(child!=IntPtr.Zero) { int id=ExportCommand(child); if(id>=0) return id; }
        }
        return -1;
    }
}
'@
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
    $window = [IntPtr]::Zero
    do {
        $window = [PdfDialog]::NextWindow($window, ($Action -eq 'Save'))
        if ($window -eq [IntPtr]::Zero) { break }
        [uint32]$owner = 0
        [void][PdfDialog]::GetWindowThreadProcessId($window, [ref]$owner)
        if ($owner -ne $AppProcess) { continue }
        if ($Action -eq 'Export') {
            $menu = [PdfDialog]::GetMenu($window)
            if ($menu -eq [IntPtr]::Zero) { continue }
            $id = [PdfDialog]::ExportCommand($menu)
            if ($id -ge 0 -and [PdfDialog]::PostMessage($window, 0x111, [IntPtr]$id, [IntPtr]::Zero)) { exit 0 }
        } else {
            $save = [PdfDialog]::GetDlgItem($window, 1)
            if ($save -eq [IntPtr]::Zero -or ![PdfDialog]::IsWindowVisible($save) -or ![PdfDialog]::IsWindowEnabled($save)) { continue }
            # A posted BM_CLICK can be ignored while the common dialog is opening.
            # Deliver the Save button's BN_CLICKED notification to the dialog, then
            # confirm Windows has actually dismissed it before polling the PDF.
            if (![PdfDialog]::PostMessage($window, 0x111, [IntPtr]1, $save)) { continue }
            $attempt = [DateTime]::UtcNow.AddSeconds(2)
            do {
                Start-Sleep -Milliseconds 100
                if (![PdfDialog]::IsWindow($window) -or ![PdfDialog]::IsWindowVisible($window)) {
                    Write-Output 'MINT native Save PDF dialog accepted'
                    exit 0
                }
            } while ([DateTime]::UtcNow -lt $attempt)
        }
    } while ($true)
    Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
throw "MINT native control was unavailable for $Action"
