' HUNT // Native Desktop App Launcher
' Starts the local Next.js server silently if not already running
' and opens HUNT in a standalone desktop app window.

Option Explicit

Dim shell, fso, appDir, url, probeUrl, launchUrl, chromePath, edgePath, i
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

Function IsServerOnline(receiveTimeoutMs)
    Dim http, status
    status = 0
    On Error Resume Next
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 300, 500, 1000, receiveTimeoutMs
    http.Open "GET", probeUrl & "/favicon.ico", False
    http.Send
    ' Read Status only after a successful Send: under Resume Next an error inside
    ' an If condition continues INTO the Then branch (an offline server looked online).
    If Err.Number = 0 Then status = http.Status
    Err.Clear
    On Error GoTo 0
    IsServerOnline = (status >= 200 And status < 500)
End Function

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

If Not IsServerOnline(1000) Then
    If Not IsServerProcessRunning() Then
        shell.Run """" & appDir & "\Start-Server.bat""", 0, False
    End If

    ' Wait until the local server responds (typically < 0.5s with next start).
    For i = 1 To 40
        WScript.Sleep 200
        If IsServerOnline(2500) Then
            Exit For
        End If
    Next
End If

EnsureKeyFile

' Open HUNT in standalone App Mode using full browser executable path
chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

If fso.FileExists(chromePath) Then
    shell.Run """" & chromePath & """ --app=" & launchUrl, 1, False
ElseIf fso.FileExists(edgePath) Then
    shell.Run """" & edgePath & """ --app=" & launchUrl, 1, False
Else
    shell.Run "cmd.exe /c start """" """ & launchUrl & """", 0, False
End If
