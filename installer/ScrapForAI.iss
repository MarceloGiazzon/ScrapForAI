; ScrapForAI installer
; Build:  iscc installer\ScrapForAI.iss
; Requires installer\staging to exist (run Build-Staging.ps1 first).

#define AppName        "ScrapForAI"
#ifndef AppVersion
  #define AppVersion   "1.0.0"
#endif
#define AppPublisher   "Punto Exe"

[Setup]
AppId={{7C3A5E10-2C4A-4C9E-9E1B-9A3F0B7D4E21}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
; Per-user install into LocalAppData: no administrator rights required.
DefaultDirName={localappdata}\{#AppName}\app
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
OutputDir=output
OutputBaseFilename=ScrapForAI-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayName={#AppName}

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "pt"; MessagesFile: "compiler:Languages\Portuguese.isl"

[Tasks]
Name: "startatlogon"; Description: "Start ScrapForAI automatically at logon"; GroupDescription: "Startup"
Name: "desktopicon";  Description: "Create a desktop shortcut";               GroupDescription: "Shortcuts"; Flags: unchecked

[Files]
Source: "staging\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "assets\Start-ScrapForAI.ps1";          DestDir: "{app}\assets"; Flags: ignoreversion
Source: "assets\Register-ScrapForAITask.ps1";   DestDir: "{app}\assets"; Flags: ignoreversion

[Icons]
Name: "{group}\ScrapForAI Console"; \
  Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\assets\Start-ScrapForAI.ps1"""; \
  WorkingDir: "{app}"

Name: "{group}\User Manual"; Filename: "{app}\docs\_userManual\index.html"

Name: "{group}\Uninstall ScrapForAI"; Filename: "{uninstallexe}"

Name: "{userdesktop}\ScrapForAI"; \
  Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\assets\Start-ScrapForAI.ps1"""; \
  WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\assets\Register-ScrapForAITask.ps1"""; \
  Tasks: startatlogon; Flags: runhidden

Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\assets\Start-ScrapForAI.ps1"""; \
  Description: "Start ScrapForAI now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\assets\Register-ScrapForAITask.ps1"" -Unregister"; \
  Flags: runhidden; RunOnceId: "UnregisterTask"

[UninstallDelete]
; Remove generated config, but never the user's run history or artifacts.
; These live in {app}\app\ because the server resolves .env next to its dist/ directory.
Type: files; Name: "{app}\app\.env"
Type: files; Name: "{app}\app\.env.bak"
