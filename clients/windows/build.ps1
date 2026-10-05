param(
  [string]$Version = $env:PVAC_VERSION,
  [string]$BuildSha = $env:PVAC_BUILD_SHA,
  [string]$Iscc = 'ISCC.exe'
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$') {
  throw '请通过 -Version 或 PVAC_VERSION 提供版本，例如 0.1.0 或 0.1.0-rc1'
}
$NumericFileVersion = ($Version -split '-')[0] + '.0'
foreach ($part in ($NumericFileVersion -split '\.')) {
  if ([long]$part -gt 65535) { throw '数字版本分量不得超过 65535' }
}
if (!(Test-Path '../shared/app.ico')) { throw '缺少共享图标 clients/shared/app.ico' }
# 不安装或下载构建工具；NuGet 恢复由有网络的发布环境执行。
dotnet publish PvAc.Client.csproj -c Release -r win-x64 --self-contained true "-p:ClientVersion=$Version" "-p:FileVersion=$NumericFileVersion" "-p:AssemblyVersion=$NumericFileVersion" "-p:ClientBuildSha=$BuildSha" -o publish
if ($LASTEXITCODE -ne 0) { throw 'Windows 客户端发布失败' }
& $Iscc "/DClientVersion=$Version" "/DNumericFileVersion=$NumericFileVersion" installer.iss
if ($LASTEXITCODE -ne 0) { throw '安装程序生成失败' }
