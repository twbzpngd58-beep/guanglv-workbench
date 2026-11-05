; 光律制图器 Windows 安装包（Inno Setup 6）。由 installer/windows/build.ps1 调用，
; 参数：/DAppVersion /DSrcDir /DIco /DOutDir
#define MyAppName "光律制图器"
#define MyAppPublisher "光律照明"
#define MyDataDirName "guanglv-workbench"

[Setup]
AppId={{A9C4D2E7-6B18-4C0F-9A53-2F7E1D4B8C60}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyDataDirName}
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\app-icon.ico
DisableProgramGroupPage=yes
DisableWelcomePage=no
SetupIconFile={#Ico}
OutputDir={#OutDir}
OutputBaseFilename=guanglv-workbench-{#AppVersion}-windows-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
CloseApplications=no
RestartApplications=no

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加图标："

[Files]
Source: "{#SrcDir}\app\*"; DestDir: "{app}\app"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#SrcDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#Ico}"; DestDir: "{app}"; DestName: "app-icon.ico"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\runtime\pythonw.exe"; Parameters: "-I -B ""{app}\app\installer\serve.py"""; WorkingDir: "{app}\app"; IconFilename: "{app}\app-icon.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\runtime\pythonw.exe"; Parameters: "-I -B ""{app}\app\installer\serve.py"""; WorkingDir: "{app}\app"; IconFilename: "{app}\app-icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\runtime\pythonw.exe"; Parameters: "-I -B ""{app}\app\installer\serve.py"""; WorkingDir: "{app}\app"; Description: "立即启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: dirifempty; Name: "{app}"
