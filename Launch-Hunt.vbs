' HUNT // Native Desktop App Launcher
' Starts (or refreshes) the local Next.js server silently and opens HUNT in
' a borderless fullscreen app window so the Windows taskbar stays hidden.

Option Explicit

Dim shell, fso, appDir, url, probeUrl, launchUrl, browserExe, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = appDir
' Keep localhost in launchUrl so Chrome preserves the existing IndexedDB/localStorage origin.
' Probe 127.0.0.1 directly: Start-Server.bat binds IPv4 (0.0.0.0), whereas "localhost" resolves
' to IPv6 (::1) first on Windows and timed out for ~2s on every check even when the server was up.
url = "http://localhost:3000"
probeUrl = "http://127.0.0.1:3000"
launchUrl = url

' Ensures local/Desktop/Start Menu shortcuts pointing at this Hunt folder use HUNT-Falcon.ico
' (a fresh filename that bypasses stale Windows Explorer iconcache_*.db entries for HUNT-Orbital.ico / HUNT.ico).
Sub RefreshHuntShortcuts()
    Dim iconPath, lnkPaths, p, sc, targetCombined, updatedAny
    iconPath = appDir & "\HUNT-Falcon.ico"
    If Not fso.FileExists(iconPath) Then iconPath = appDir & "\HUNT.ico"
    If Not fso.FileExists(iconPath) Then Exit Sub

    updatedAny = False
    On Error Resume Next
    lnkPaths = Array( _
        appDir & "\HUNT.lnk", _
        appDir & "\Hunt.lnk", _
        shell.SpecialFolders("Desktop") & "\HUNT.lnk", _
        shell.SpecialFolders("Desktop") & "\Hunt.lnk", _
        shell.SpecialFolders("Programs") & "\HUNT.lnk", _
        shell.SpecialFolders("Programs") & "\Hunt.lnk", _
        shell.SpecialFolders("Programs") & "\Hunt\HUNT.lnk", _
        shell.SpecialFolders("Programs") & "\Hunt\Hunt.lnk" _
    )
    For Each p In lnkPaths
        If fso.FileExists(p) Then
            Set sc = shell.CreateShortcut(p)
            If Err.Number = 0 Then
                targetCombined = LCase("" & sc.TargetPath & " " & sc.Arguments & " " & sc.WorkingDirectory)
                If InStr(targetCombined, LCase(appDir)) > 0 Then
                    If InStr(LCase("" & sc.IconLocation), LCase(iconPath)) = 0 Then
                        sc.IconLocation = iconPath & ",0"
                        sc.Save
                        If Err.Number = 0 Then updatedAny = True
                    End If
                End If
            End If
            Err.Clear
        End If
    Next
    If updatedAny Then
        shell.Run "ie4uinit.exe -show", 0, False
    End If
    Err.Clear
    On Error GoTo 0
End Sub

Function IsServerOnline(receiveTimeoutMs)
    Dim http, status, rootStatus
    status = 0
    rootStatus = 0
    On Error Resume Next
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 300, 500, 1000, receiveTimeoutMs
    http.Open "GET", probeUrl & "/favicon.ico", False
    http.Send
    ' Read Status only after a successful Send: under Resume Next an error inside
    ' an If condition continues INTO the Then branch (an offline server looked online).
    If Err.Number = 0 Then status = http.Status
    Err.Clear
    If status >= 200 And status < 500 Then
        http.Open "GET", probeUrl & "/", False
        http.Send
        If Err.Number = 0 Then rootStatus = http.Status
        Err.Clear
    End If
    On Error GoTo 0
    IsServerOnline = (status >= 200 And status < 500 And rootStatus >= 200 And rootStatus < 400)
End Function

' Parses WMI DMTF datetime (YYYYMMDDHHMMSS.ffffff+UUU) into a VBScript Date in local time.
Function ParseWmiDate(wmiStr)
    Dim yr, mo, dy, hr, mn, sc
    ParseWmiDate = CDate(0)
    If Len("" & wmiStr) < 14 Then Exit Function
    On Error Resume Next
    yr = CInt(Mid(wmiStr, 1, 4))
    mo = CInt(Mid(wmiStr, 5, 2))
    dy = CInt(Mid(wmiStr, 7, 2))
    hr = CInt(Mid(wmiStr, 9, 2))
    mn = CInt(Mid(wmiStr, 11, 2))
    sc = CInt(Mid(wmiStr, 13, 2))
    If Err.Number = 0 Then ParseWmiDate = DateSerial(yr, mo, dy) + TimeSerial(hr, mn, sc)
    Err.Clear
    On Error GoTo 0
End Function

' If a detached node.exe from an older build is still serving port 3000 after
' `.next\BUILD_ID` was rebuilt, terminate it so Start-Server.bat boots the fresh bundle
' (preventing stale HTML / missing chunk 404s on first open).
Sub StopStaleServerIfRebuilt()
    Dim buildIdPath, buildTime, wmi, procs, proc, cmd, procStarted, terminatedAny
    buildIdPath = appDir & "\.next\BUILD_ID"
    If Not fso.FileExists(buildIdPath) Then
        buildIdPath = appDir & "\server.js"
    End If
    If Not fso.FileExists(buildIdPath) Then Exit Sub

    On Error Resume Next
    buildTime = fso.GetFile(buildIdPath).DateLastModified
    If Err.Number <> 0 Then
        Err.Clear
        On Error GoTo 0
        Exit Sub
    End If

    terminatedAny = False
    Set wmi = GetObject("winmgmts:\\.\root\cimv2")
    Set procs = wmi.ExecQuery("SELECT ProcessId, CommandLine, CreationDate FROM Win32_Process WHERE Name = 'node.exe'")
    For Each proc In procs
        cmd = LCase("" & proc.CommandLine)
        If InStr(cmd, LCase(appDir)) > 0 And (InStr(cmd, "next") > 0 Or InStr(cmd, "server.js") > 0) Then
            procStarted = ParseWmiDate(proc.CreationDate)
            If procStarted > CDate(0) And DateDiff("s", procStarted, buildTime) > 2 Then
                proc.Terminate()
                terminatedAny = True
            End If
        End If
    Next
    Err.Clear
    On Error GoTo 0
    If terminatedAny Then WScript.Sleep 400
End Sub

' Checks whether a local Hunt Next.js process is already starting up so rapid
' double-launches do not spawn a competing server on port 3000.
Function IsServerProcessRunning()
    Dim wmi, procs, proc, cmd
    IsServerProcessRunning = False
    On Error Resume Next
    Set wmi = GetObject("winmgmts:\\.\root\cimv2")
    Set procs = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name = 'node.exe'")
    For Each proc In procs
        cmd = LCase("" & proc.CommandLine)
        If InStr(cmd, LCase(appDir)) > 0 And (InStr(cmd, "next") > 0 Or InStr(cmd, "server.js") > 0) Then
            IsServerProcessRunning = True
            Exit For
        End If
    Next
    Err.Clear
    On Error GoTo 0
End Function

' The sync key from data\hunt-sync.key, or "" when it is missing, unreadable or
' not a plain alphanumeric key of at least 32 characters.
Function ReadSyncKey()
    Dim keyPath, stream, key, re
    ReadSyncKey = ""
    key = ""
    keyPath = appDir & "\data\hunt-sync.key"
    On Error Resume Next
    If fso.FileExists(keyPath) Then
        Set stream = fso.OpenTextFile(keyPath, 1)
        If Err.Number = 0 Then key = stream.ReadAll
        If Err.Number = 0 Then stream.Close
        If Err.Number <> 0 Then key = ""
    End If
    Err.Clear
    On Error GoTo 0
    ' Trim like the server does (spaces, tabs and line breaks at both ends).
    Set re = New RegExp
    re.Global = True
    re.Pattern = "^\s+|\s+$"
    key = re.Replace(key, "")
    re.Pattern = "^[0-9A-Za-z]+$"
    If Len(key) >= 32 And re.Test(key) Then ReadSyncKey = key
End Function

' Opens the desktop window with ?token=<key> (the page stores the key and strips
' it from the address bar). A missing key file is created by the server on any
' /api/sync request, which is answered 401; the long receive timeout covers the
' route's first compile under "next dev". On any error the plain URL is used,
' since the desktop keeps the key it saved before.
Sub EnsureKeyFile()
    Dim http, key
    key = ReadSyncKey()
    If key = "" Then
        On Error Resume Next
        Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
        http.setTimeouts 300, 500, 1000, 10000
        http.Open "GET", probeUrl & "/api/sync", False
        http.Send
        Err.Clear
        On Error GoTo 0
        key = ReadSyncKey()
    End If
    If key <> "" Then launchUrl = url & "/?token=" & key
End Sub

Function FindChromiumBrowser()
    Dim candidates, c
    FindChromiumBrowser = ""
    candidates = Array( _
        "C:\Program Files\Google\Chrome\Application\chrome.exe", _
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe", _
        shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Google\Chrome\Application\chrome.exe", _
        "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", _
        "C:\Program Files\Microsoft\Edge\Application\msedge.exe" _
    )
    For Each c In candidates
        If fso.FileExists(c) Then
            FindChromiumBrowser = c
            Exit Function
        End If
    Next
End Function

' When Chrome/Edge already has an open desktop session, `--start-fullscreen` on a
' new `--app` window can be ignored by the existing browser process, leaving the
' bottom Windows taskbar visible. This helper locates the Hunt HWND via EnumWindows
' (multi-monitor aware), sets its native taskbar/Alt-Tab icon to HUNT-Falcon.ico,
' and sends F11 directly to that HWND only if it is not yet fullscreen.
Sub EnsureHuntWindowFullscreen()
    Dim psCmd, iconPath, escapedIconPath
    iconPath = appDir & "\HUNT-Falcon.ico"
    If Not fso.FileExists(iconPath) Then iconPath = appDir & "\HUNT.ico"
    escapedIconPath = Replace(iconPath, "'", "''")
    psCmd = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command " & _
        """$ico = '" & escapedIconPath & "'; " & _
        "Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; " & _
        "public class HuntWin { " & _
        "public delegate bool EnumProc(IntPtr h, IntPtr l); " & _
        "[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; } " & _
        "[StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; } " & _
        "[DllImport(\""user32.dll\"")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam); " & _
        "[DllImport(\""user32.dll\"")] public static extern bool IsWindowVisible(IntPtr h); " & _
        "[DllImport(\""user32.dll\"", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max); " & _
        "[DllImport(\""user32.dll\"", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max); " & _
        "[DllImport(\""user32.dll\"")] public static extern bool GetWindowRect(IntPtr h, out RECT r); " & _
        "[DllImport(\""user32.dll\"")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags); " & _
        "[DllImport(\""user32.dll\"")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi); " & _
        "[DllImport(\""user32.dll\"")] public static extern bool SetForegroundWindow(IntPtr h); " & _
        "[DllImport(\""user32.dll\"")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); " & _
        "[DllImport(\""user32.dll\"")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l); " & _
        "[DllImport(\""user32.dll\"", CharSet=CharSet.Unicode)] public static extern IntPtr LoadImage(IntPtr hInst, string name, uint type, int cx, int cy, uint fuLoad); " & _
        "public static IntPtr FindHuntWindow() { " & _
        "  IntPtr exact = IntPtr.Zero, fallback = IntPtr.Zero; " & _
        "  EnumWindows((h, l) => { " & _
        "    if (!IsWindowVisible(h)) return true; " & _
        "    var cls = new StringBuilder(64); GetClassName(h, cls, 64); " & _
        "    if (!cls.ToString().StartsWith(\""Chrome_WidgetWin_\"")) return true; " & _
        "    var sb = new StringBuilder(256); GetWindowText(h, sb, 256); " & _
        "    var t = sb.ToString(); " & _
        "    if (t.StartsWith(\""Hunt \"" + (char)0x2014 + \"" Make time\"", StringComparison.OrdinalIgnoreCase)) { " & _
        "      if (!t.Contains(\"" - Google Chrome\"") && !t.Contains(\"" - Microsoft\"")) { exact = h; return false; } " & _
        "      if (fallback == IntPtr.Zero) fallback = h; " & _
        "    } " & _
        "    return true; " & _
        "  }, IntPtr.Zero); " & _
        "  return exact != IntPtr.Zero ? exact : fallback; " & _
        "} }'; " & _
        "for ($k = 0; $k -lt 25; $k++) { " & _
        "  $h = [HuntWin]::FindHuntWindow(); " & _
        "  if ($h -ne [IntPtr]::Zero) { " & _
        "    if (Test-Path $ico) { " & _
        "      $sm = [HuntWin]::LoadImage([IntPtr]::Zero, $ico, 1, 32, 32, 0x10); " & _
        "      $lg = [HuntWin]::LoadImage([IntPtr]::Zero, $ico, 1, 256, 256, 0x10); " & _
        "      if ($sm -ne [IntPtr]::Zero) { [void][HuntWin]::SendMessage($h, 0x0080, [IntPtr]0, $sm); } " & _
        "      if ($lg -ne [IntPtr]::Zero) { [void][HuntWin]::SendMessage($h, 0x0080, [IntPtr]1, $lg); } " & _
        "    } " & _
        "    $r = New-Object HuntWin+RECT; [void][HuntWin]::GetWindowRect($h, [ref]$r); " & _
        "    $mi = New-Object HuntWin+MONITORINFO; $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi); " & _
        "    $mon = [HuntWin]::MonitorFromWindow($h, 2); " & _
        "    [void][HuntWin]::GetMonitorInfo($mon, [ref]$mi); " & _
        "    $monH = $mi.rcMonitor.B - $mi.rcMonitor.T; " & _
        "    if ($monH -gt 0 -and ($r.B - $r.T) -lt ($monH - 8)) { " & _
        "      [void][HuntWin]::SetForegroundWindow($h); " & _
        "      [void][HuntWin]::PostMessage($h, 0x0100, [IntPtr]0x7A, [IntPtr]0); " & _
        "      [void][HuntWin]::PostMessage($h, 0x0101, [IntPtr]0x7A, [IntPtr]0); " & _
        "    } " & _
        "    break; " & _
        "  } " & _
        "  Start-Sleep -Milliseconds 160; " & _
        "}"""
    On Error Resume Next
    shell.Run psCmd, 0, False
    Err.Clear
    On Error GoTo 0
End Sub

RefreshHuntShortcuts
StopStaleServerIfRebuilt

If Not IsServerOnline(1200) Then
    If Not IsServerProcessRunning() Then
        shell.Run """" & appDir & "\Start-Server.bat""", 0, False
    End If

    ' Wait until the local server responds on both /favicon.ico and / (up to ~15s).
    For i = 1 To 75
        WScript.Sleep 200
        If IsServerOnline(2500) Then
            Exit For
        End If
    Next
End If

EnsureKeyFile

' Open HUNT in standalone fullscreen App Mode (hiding the bottom Windows taskbar)
browserExe = FindChromiumBrowser()
If browserExe <> "" Then
    shell.Run """" & browserExe & """ --app=" & launchUrl & " --start-fullscreen", 1, False
    EnsureHuntWindowFullscreen
Else
    shell.Run "cmd.exe /c start """" """ & launchUrl & """", 0, False
End If
