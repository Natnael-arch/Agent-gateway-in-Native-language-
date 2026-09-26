; ==============================================================================
; Agelgay Windows Installer Packaging Script (Inno Setup 6.x)
; Non-administrative, zero-prerequisites installer for Agelgay Amharic Agent Gateway
; ==============================================================================

[Setup]
AppName=Agelgay
AppVersion=1.0.0
AppPublisher=Agelgay
AppPublisherURL=https://github.com/Natnael-arch/Agent-gateway-in-Native-language-
AppSupportURL=https://github.com/Natnael-arch/Agent-gateway-in-Native-language-
AppUpdatesURL=https://github.com/Natnael-arch/Agent-gateway-in-Native-language-
DefaultDirName={localappdata}\Agelgay
DefaultGroupName=Agelgay
DisableProgramGroupPage=yes
OutputBaseFilename=Agelgay-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayIcon={app}\agent-gateway\public\favicon.ico
ChangesEnvironment=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Portable Node.js runtime (v22 LTS x64 Windows)
Source: "..\node\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs createallsubdirs
; Amharic Agent Gateway application
Source: "..\agent-gateway\*"; DestDir: "{app}\agent-gateway"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "node_modules\.cache\*,.git\*,*.log"
; Hermes AI Agent CLI & virtual environment
Source: "..\hermes\*"; DestDir: "{app}\hermes"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "*.pyc,__pycache__\*"
; Activation & launcher scripts
Source: "activate.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "activate.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "start.cmd"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Agelgay Gateway"; Filename: "{app}\start.cmd"; Comment: "Start the Agelgay Amharic Agent Gateway"
Name: "{group}\Re-activate Agelgay"; Filename: "{app}\activate.cmd"; Comment: "Re-run Agelgay activation and machine fingerprint binding"
Name: "{group}\{cm:UninstallProgram,Agelgay}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Agelgay"; Filename: "{app}\start.cmd"; Tasks: desktopicon; Comment: "Start the Agelgay Amharic Agent Gateway"

[Run]
; Launch interactive activation console window immediately after installation completes
Filename: "cmd.exe"; Parameters: "/c start ""Agelgay Activation"" ""{app}\activate.cmd"""; Description: "Launch Agelgay Activation script"; Flags: postinstall nowait
