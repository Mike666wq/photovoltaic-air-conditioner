; 发布时由 build.ps1 注入版本，稳定 AppId 保证原地升级。
#ifndef ClientVersion
  #define ClientVersion "0.0.0"
#endif
#ifndef NumericFileVersion
  #define NumericFileVersion "0.0.0.0"
#endif
[Setup]
AppId={{C1E9C094-E597-41DF-91C0-2CD252314380}
AppName=光伏·空调监控
AppVersion={#ClientVersion}
VersionInfoVersion={#NumericFileVersion}
AppPublisher=光伏·空调监控
DefaultDirName={localappdata}\Programs\PvAcMonitor
DefaultGroupName=光伏·空调监控
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\artifacts
OutputBaseFilename=PvAcMonitor-client-v{#ClientVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\shared\app.ico
UninstallDisplayIcon={app}\PvAc.Client.exe
CloseApplications=yes
RestartApplications=no
[Tasks]
Name: desktopicon; Description: "创建桌面快捷方式"; Flags: unchecked
[Files]
Source: "publish\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\光伏·空调监控"; Filename: "{app}\PvAc.Client.exe"
Name: "{autodesktop}\光伏·空调监控"; Filename: "{app}\PvAc.Client.exe"; Tasks: desktopicon
[Run]
Filename: "{app}\PvAc.Client.exe"; Description: "启动光伏·空调监控"; Flags: nowait postinstall skipifsilent
[UninstallDelete]
; 只清除此应用的 cookie/profile；用户保存到下载目录的文件不在清理范围。
Type: filesandordirs; Name: "{localappdata}\PvAcMonitor\WebView2"
[Code]
function HasRuntime: Boolean;
var Version: String;
begin
  Result := (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
  if not Result then
    Result := (RegQueryStringValue(HKLM32, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
end;
procedure CurStepChanged(CurStep: TSetupStep);
var ErrorCode: Integer;
begin
  if (CurStep = ssPostInstall) and not HasRuntime then begin
    if MsgBox('需要 Microsoft Evergreen WebView2 运行时。现在打开微软官网下载安装 Bootstrapper？安装后即可启动客户端。', mbInformation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/#download-section', '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
  end;
end;
