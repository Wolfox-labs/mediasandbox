#Requires -Version 7.0
<#
.SYNOPSIS
  构建 MediaSandbox 的三套沙盒镜像。

.DESCRIPTION
  分别对应三类环境：frontend（Node 工具链）、image（Python + ffmpeg）、copy（极简文本环境）。

  注意 Dockerfile 里的 FROM 写的是完整镜像源前缀（docker.m.daocloud.io/...），
  因为本机实测 `registry-mirrors` 对短名拉取不生效，写 `node:22-alpine` 会去
  registry-1.docker.io 直连并超时。

  构建完成后会逐一验证容器能起来、且关键命令真的可用——
  镜像构建成功不等于里面的运行时可用（本机宿主就有 WindowsApps 假 python 的教训）。
#>
[CmdletBinding()]
param(
  [string[]] $Only = @(),
  [switch]   $NoCache
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ImageDir = Join-Path $RepoRoot 'packages\sandbox\images'

$Targets = @(
  @{ Env = 'frontend'; File = 'frontend.Dockerfile'; Tag = 'mediasandbox/frontend:latest'; Probe = 'node --version' }
  @{ Env = 'image';    File = 'image.Dockerfile';    Tag = 'mediasandbox/image:latest';    Probe = 'python -c "import PIL,numpy;print(1)"' }
  @{ Env = 'copy';     File = 'copy.Dockerfile';     Tag = 'mediasandbox/copy:latest';     Probe = 'node --version' }
)

function Resolve-DockerExe {
  $onPath = Get-Command docker -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  $candidates = @(
    (Join-Path ${env:ProgramFiles} 'Docker\Docker\resources\bin\docker.exe'),
    (Join-Path ${env:LOCALAPPDATA} 'Docker\Docker\resources\bin\docker.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw '找不到 docker。请确认 Docker Desktop 已安装且在运行。'
}

$Docker = Resolve-DockerExe

function Write-Step([string] $Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string] $Message)   { Write-Host "    $Message" -ForegroundColor Green }
function Write-Bad([string] $Message)  { Write-Host "    $Message" -ForegroundColor Red }

Write-Step '确认 Docker 引擎可用'
$serverVersion = & $Docker version --format '{{.Server.Version}}' 2>$null
if ($LASTEXITCODE -ne 0 -or -not $serverVersion) {
  throw 'Docker 引擎未就绪。请先启动 Docker Desktop。'
}
Write-Ok "引擎 $serverVersion"

$selected = if ($Only.Count -gt 0) {
  $Targets | Where-Object { $Only -contains $_.Env }
} else {
  $Targets
}

if ($selected.Count -eq 0) {
  throw "没有匹配的目标。可用值: $($Targets.Env -join ', ')"
}

$failures = @()

foreach ($target in $selected) {
  $dockerfile = Join-Path $ImageDir $target.File
  if (-not (Test-Path -LiteralPath $dockerfile)) {
    throw "找不到 Dockerfile: $dockerfile"
  }

  Write-Step "构建 $($target.Tag)"
  $buildArgs = @(
    'build', '--file', $dockerfile, '--tag', $target.Tag
  )
  if ($NoCache) { $buildArgs += '--no-cache' }
  $buildArgs += $ImageDir

  & $Docker @buildArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Bad "构建失败: $($target.Tag)"
    $failures += $target.Env
    continue
  }
  Write-Ok "构建完成: $($target.Tag)"

  # 构建成功 ≠ 里面能用。实际起一个容器跑探针。
  Write-Step "验证 $($target.Env) 镜像内的运行时"
  $probeOutput = & $Docker run --rm --network none $target.Tag sh -c $target.Probe 2>&1
  if ($LASTEXITCODE -eq 0) {
    Write-Ok "探针通过: $($target.Probe)"
  } else {
    Write-Bad "探针失败: $($target.Probe)"
    Write-Bad ($probeOutput -join "`n")
    $failures += "$($target.Env)（运行时不可用）"
  }

  # 顺带确认容器以非 root 运行。
  $uid = & $Docker run --rm --network none $target.Tag id -u 2>&1
  if ($uid -eq '1000') {
    Write-Ok '以非 root（uid 1000）运行'
  } else {
    Write-Bad "预期 uid 1000，实际 $uid"
    $failures += "$($target.Env)（用户不正确）"
  }
}

Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host "以下目标未通过: $($failures -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host "全部镜像构建并验证通过。" -ForegroundColor Green
& $Docker images --filter 'reference=mediasandbox/*'
