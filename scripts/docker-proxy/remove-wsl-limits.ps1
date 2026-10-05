#Requires -Version 7.0
<#
.SYNOPSIS
  移除 WSL2 资源上限配置，回到系统默认策略。

.DESCRIPTION
  本目录下的 .wslconfig 由项目为规避 OOM 而添加到 %USERPROFILE%。
  删除该文件并关闭 WSL 虚拟机后，WSL2 恢复默认内存策略（内存的 50%）。

  注意：若 %USERPROFILE%\.wslconfig 本来就是你自己的配置（而非本项目添加的），
  请勿执行本脚本，以免丢失你的设置。

  本脚本在删除前会把文件另存为 .wslconfig.removed，便于后悔时恢复。
#>
[CmdletBinding()]
param(
  [switch] $Purge  # 连备份一起删掉
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ConfigPath = Join-Path $env:USERPROFILE '.wslconfig'
$BackupPath = Join-Path $env:USERPROFILE '.wslconfig.removed'

function Write-Step([string] $Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string] $Message)   { Write-Host "    $Message" -ForegroundColor Green }
function Write-Warn2([string] $Message){ Write-Host "    $Message" -ForegroundColor Yellow }

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  Write-Warn2 "$ConfigPath 不存在，无需处理。"
  exit 0
}

Write-Step '当前配置内容'
Get-Content -LiteralPath $ConfigPath -Raw

Write-Step "另存为 $BackupPath"
Copy-Item -LiteralPath $ConfigPath -Destination $BackupPath -Force
Write-Ok '已备份'

Write-Step '删除配置'
Remove-Item -LiteralPath $ConfigPath -Force
Write-Ok '已删除'

Write-Step '关闭 WSL 虚拟机以使改动生效'
& wsl.exe --shutdown 2>$null | Out-Null
Start-Sleep -Seconds 3
Write-Ok '已执行 wsl --shutdown'

Write-Step '当前 WSL 状态'
(wsl.exe -l -v 2>&1) -replace "`0", '' | Write-Host

if ($Purge) {
  Remove-Item -LiteralPath $BackupPath -Force -ErrorAction SilentlyContinue
  Write-Ok "已删除备份 $BackupPath"
} else {
  Write-Host ''
  Write-Host "备份保留在 $BackupPath" -ForegroundColor Cyan
  Write-Host '要恢复上限，把它改回 .wslconfig 并执行 wsl --shutdown 即可。' -ForegroundColor White
}
