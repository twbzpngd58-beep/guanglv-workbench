# 组装 Windows 安装包载荷并用 Inno Setup 编译。
# 用法：pwsh -File installer/windows/build.ps1 -Runtime build/windows/runtime
param(
    [Parameter(Mandatory = $true)][string]$Runtime,
    [string]$Root = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [string]$Stage = "",
    [string]$Out = ""
)
$ErrorActionPreference = "Stop"

$Runtime = (Resolve-Path $Runtime).Path
$Version = (Get-Content -Raw "$Root\VERSION").Trim()
if (-not $Stage) { $Stage = Join-Path $Root "build\windows" }
if (-not $Out) { $Out = Join-Path $Root "dist" }
$Python = Join-Path $Runtime "python.exe"
if (-not (Test-Path $Python)) { throw "运行时缺少 python.exe：$Python" }

if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path $Stage, $Out | Out-Null

& $Python -X utf8 "$Root\installer\pack.py" --out (Join-Path $Stage "app")
if ($LASTEXITCODE -ne 0) { throw "载荷复制失败" }

& robocopy $Runtime (Join-Path $Stage "runtime") /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "运行时复制失败，robocopy 退出码 $LASTEXITCODE" }

$Png = Join-Path $Root "installer\assets\app-icon.png"
$Ico = Join-Path $Stage "app-icon.ico"
if (Test-Path $Png) {
    & $Python -X utf8 -c "from PIL import Image; im = Image.open(r'$Png').convert('RGBA'); im.save(r'$Ico', 'ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
    if (-not (Test-Path $Ico)) { throw "图标生成失败" }
} else {
    throw "缺少 installer\assets\app-icon.png，Inno Setup 必须有 .ico"
}

# Inno Setup 读不到无 BOM 的 UTF-8 中文，编译前先补上 BOM。
$Iss = Join-Path $Stage "guanglv.iss"
$Text = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot "guanglv.iss")
[System.IO.File]::WriteAllText($Iss, $Text, (New-Object System.Text.UTF8Encoding($true)))

$Iscc = Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"
if (-not (Test-Path $Iscc)) { $Iscc = Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe" }
if (-not (Test-Path $Iscc)) { throw "未找到 Inno Setup 编译器：$Iscc" }

& $Iscc "/DAppVersion=$Version" "/DSrcDir=$Stage" "/DIco=$Ico" "/DOutDir=$Out" $Iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup 编译失败" }

$Installer = Join-Path $Out "guanglv-workbench-$Version-windows-x64.exe"
if (-not (Test-Path $Installer)) { throw "没有生成安装包：$Installer" }
$Size = [math]::Round((Get-Item $Installer).Length / 1MB, 1)
Write-Host "installer: $Installer ($Size MB)"
Write-Host ((Get-FileHash -Algorithm SHA256 $Installer).Hash.ToLower() + "  " + (Split-Path -Leaf $Installer))
