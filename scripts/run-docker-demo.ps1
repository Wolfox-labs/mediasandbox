# 在**你自己的终端**里启动 MediaSandbox（含 Docker 真浏览器能力）。
#
# 为什么需要这个脚本：
#   DSH 工具进程跑在 **Low 完整性级别**（`whoami /groups` 里的
#   `Mandatory Label\Low Mandatory Level`），而 Windows 的强制完整性控制会拦掉
#   Low 进程对 Docker 命名管道（Medium 完整性）的访问 —— 症状是
#   `connect EPERM //./pipe/docker_engine`。
#   实测：`docker.exe`（原生，Medium）能连；`python.exe` 打开管道 OK；
#   而 DSH 起的 `node.exe`（Low）一律 EPERM。
#
#   所以「真截图 + 交互验证」这两站必须从一个普通终端起服务。
#   本脚本把 PATH 与服务日志都安排好，双击或右键「使用 PowerShell 运行」即可。
#
# ASCII-only on purpose: Windows PowerShell 5.1 parses .ps1 as ANSI without a BOM.

$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "=== MediaSandbox (Docker 真浏览器) ===" -ForegroundColor Cyan
Write-Host "仓库: $RepoRoot"

# Docker CLI 不在 PATH 时补上。
$dockerBin = Join-Path ${env:ProgramFiles} 'Docker\Docker\resources\bin'
if ((Test-Path $dockerBin) -and ($env:PATH -notlike "*$dockerBin*")) {
    $env:PATH = "$dockerBin;$env:PATH"
}

# 先确认引擎在。
$server = (& docker version --format '{{.Server.Version}}' 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $server) {
    Write-Host "Docker 引擎没起来。先启动 Docker Desktop，等托盘图标变绿再跑本脚本。" -ForegroundColor Red
    Read-Host "按回车键关闭"
    exit 1
}
Write-Host "Docker 引擎: $server" -ForegroundColor Green

# 确认四套镜像都在。
$images = & docker images --filter 'reference=mediasandbox/*' --format '{{.Repository}}:{{.Tag}}'
Write-Host "镜像:" -ForegroundColor Green
$images | ForEach-Object { Write-Host "  $_" }

# node：优先用系统 node；本机是 DSH 附带的那个。
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'deepseek-harness\..\..\..\_tools\node\node.exe'),
        'D:\github123\_tools\node\node.exe'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { $node = $candidate; break }
    }
}
if (-not $node) {
    Write-Host "找不到 node.exe。请把 node 装到 PATH，或改本脚本里的 `$node 变量。" -ForegroundColor Red
    Read-Host "按回车键关闭"
    exit 1
}
Write-Host "node: $node" -ForegroundColor Green

$port = if ($env:PORT) { $env:PORT } else { '8787' }
Write-Host ""
Write-Host "服务地址: http://127.0.0.1:$port/" -ForegroundColor Yellow
Write-Host "演示导览: 提交一次 webpage 运行（勾上截图）-> 右栏看页面与截图 -> 中栏点「交互验证」"
Write-Host "停止服务: 在本窗口按 Ctrl-C"
Write-Host ""

# 起服务（前台）。环境变量与 pnpm start 一致，只是显式指定了 node。
& $node --env-file-if-exists=.env 'packages/server/dist/main.js'
