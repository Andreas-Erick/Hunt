; Hunt Desktop Windows Installer (Inno Setup 6)
; Compiled in GitHub Actions via: iscc /DAppVersion=1.15.0 /DStageDir=... installer/hunt-desktop.iss

#ifndef AppVersion
  #define AppVersion "1.15.0"
#endif

#ifndef StageDir
  #define StageDir "..\dist\desktop-stage"
#endif

#ifndef OutputDir
  #define OutputDir "..\dist\release"
#endif

[Setup]
AppId={{8E92D63B-3A14-4C9C-9A2B-7F8B413B7C11}
AppName=Hunt
AppVersion={#AppVersion}
AppPublisher=Hunt
AppSupportURL=https://github.com/Andreas-Erick/Hunt
DefaultDirName={localappdata}\Programs\Hunt
DefaultGroupName=Hunt
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DisableProgramGroupPage=yes
SetupIconFile=..\HUNT-Falcon.ico
UninstallDisplayIcon={app}\HUNT-Falcon.ico
ChangesAssociations=yes
OutputDir={#OutputDir}
OutputBaseFilename=Hunt-Desktop-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

; Clear the previous version's server bundle so an upgrade matches a fresh install.
; User data lives in IndexedDB and {app}\data, which are not touched.
[InstallDelete]
Type: filesandordirs; Name: "{app}\.next"
Type: filesandordirs; Name: "{app}\node_modules"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Hunt"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\Launch-Hunt.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\HUNT-Falcon.ico"
Name: "{group}\Uninstall Hunt"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Hunt"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\Launch-Hunt.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\HUNT-Falcon.ico"; Tasks: desktopicon

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\Launch-Hunt.vbs"""; WorkingDir: "{app}"; Description: "Launch Hunt"; Flags: nowait postinstall skipifsilent
