#Requires -Version 7.0
<#
.SYNOPSIS
  测量 Docker Desktop 从冷启动到稳态的真实内存开销。

.DESCRIPTION
  采集三个维度，避免只看单一数字被误导：
    AvailableGB   真实可用物理内存（含可回收缓存），任务管理器的"可用"
    CommittedGB   已提交虚拟内存，真正的 OOM 判据（超过上限才触发）
    WslVmMB       WSL 虚拟机工作集，Docker 引擎的实际载体
    DockerMB      所有 Docker 相关进程工作集合计

  分两个阶段：
    冷启动阶段  逐秒采样，捕捉峰值
    稳态阶段    等引擎就绪后再采 30 秒，取中位数

  安全阀：可用内存低于阈值立即杀 Docker。
#>
[CmdletBinding()]
param(
  [int]    $ColdTimeoutSec = 240,
  [int]    $SteadySec      = 30,
  [double] $MinAvailableGB = 6.0
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$DockerExe = Join-Path ${env:ProgramFiles} 'Docker\Docker\Docker Desktop.exe'

function Resolve-DockerExe {
  <#
    Docker Desktop 装完默认不把 bin 目录写进 PATH。
    这里按常见安装位置兜底查找，避免脚本依赖某个固定的机器路径。
  #>
  $onPath = Get-Command docker -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }

  $candidates = @(
    (Join-Path ${env:ProgramFiles} 'Docker\Docker\resources\bin\docker.exe'),
    (Join-Path ${env:LOCALAPPDATA} 'Docker\Docker\resources\bin\docker.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  return $null
}

$DockerBin = Resolve-DockerExe
if (-not $DockerBin) {
  throw '找不到 docker 可执行文件。请确认 Docker Desktop 已安装，或把它的 bin 目录加入 PATH。'
}

function Get-AvailableGB {
  (Get-Counter '\Memory\Available MBytes' -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue / 1024
}

function Get-CommittedGB {
  $os = Get-CimInstance Win32_OperatingSystem
  ($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) / 1MB
}

function Get-CommitLimitGB {
  (Get-CimInstance Win32_OperatingSystem).TotalVirtualMemorySize / 1MB
}

function Get-WslVmMB {
  $vm = Get-Process -Name 'vmmemWSL', 'vmmem' -ErrorAction SilentlyContinue
  if (-not $vm) { return 0 }
  [int](($vm | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
}

function Get-DockerMB {
  $p = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -match 'docker|vmmemWSL' }
  if (-not $p) { return 0 }
  [int](($p | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
}

function Take-Sample {
  [pscustomobject]@{
    Time        = (Get-Date).ToString('HH:mm:ss')
    AvailableGB = [math]::Round((Get-AvailableGB), 2)
    CommittedGB = [math]::Round((Get-CommittedGB), 2)
    WslVmMB     = Get-WslVmMB
    DockerMB    = Get-DockerMB
  }
}

function Stop-DockerNow {
  param([string] $Why)
  Write-Host "!! $Why" -ForegroundColor Red
  foreach ($n in @('Docker Desktop', 'com.docker.backend', 'com.docker.build', 'docker-agent')) {
    Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  & wsl.exe --terminate docker-desktop 2>$null | Out-Null
}

# ── 确保从干净状态开始 ──────────────────────────────────────────────────
Write-Host '==> 停止所有 Docker 进程，从冷状态开始' -ForegroundColor Cyan
foreach ($n in @('Docker Desktop', 'com.docker.backend', 'com.docker.build', 'docker-agent')) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
& wsl.exe --terminate docker-desktop 2>$null | Out-Null
Start-Sleep -Seconds 8

$baseline = Take-Sample
Write-Host ''
Write-Host '════ 基线（Docker 未运行） ════' -ForegroundColor Cyan
Write-Host ("  可用内存   : {0} GB" -f $baseline.AvailableGB)
Write-Host ("  已提交     : {0} GB" -f $baseline.CommittedGB)
Write-Host ("  提交上限   : {0:N2} GB" -f (Get-CommitLimitGB))
Write-Host ("  WSL 虚拟机 : {0} MB" -f $baseline.WslVmMB)
Write-Host ''

# ── 冷启动采样 ──────────────────────────────────────────────────────────
Write-Host '==> 启动 Docker Desktop，逐秒采样' -ForegroundColor Cyan
Start-Process -FilePath $DockerExe | Out-Null

$cold = [System.Collections.Generic.List[object]]::new()
$deadline = (Get-Date).AddSeconds($ColdTimeoutSec)
$engineReady = $false
$aborted = $false
$peakWslMB = 0
$peakDockerMB = 0
$minAvailable = [double]::MaxValue

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 1
  $s = Take-Sample
  $cold.Add($s)

  if ($s.WslVmMB   -gt $peakWslMB)    { $peakWslMB = $s.WslVmMB }
  if ($s.DockerMB  -gt $peakDockerMB) { $peakDockerMB = $s.DockerMB }
  if ($s.AvailableGB -lt $minAvailable) { $minAvailable = $s.AvailableGB }

  if ($s.AvailableGB -lt $MinAvailableGB) {
    Stop-DockerNow -Why "可用内存 $($s.AvailableGB)GB 低于阈值 $MinAvailableGB GB"
    $aborted = $true
    break
  }

  $v = & $DockerBin version --format '{{.Server.Version}}' 2>$null
  if ($LASTEXITCODE -eq 0 -and $v) {
    Write-Host ("  引擎就绪于 {0}（耗时 {1} 秒）" -f $s.Time, $cold.Count) -ForegroundColor Green
    $engineReady = $true
    break
  }
}

if (-not $engineReady -and -not $aborted) {
  Write-Host '  引擎未在超时内就绪' -ForegroundColor Yellow
}

# ── 稳态采样：等 WSL 虚拟机真正起来 ─────────────────────────────────────
if ($engineReady) {
  Write-Host ''
  Write-Host "==> 稳态采样 $SteadySec 秒" -ForegroundColor Cyan
  $steady = [System.Collections.Generic.List[object]]::new()
  for ($i = 0; $i -lt $SteadySec; $i++) {
    Start-Sleep -Seconds 1
    $s = Take-Sample
    $steady.Add($s)
    if ($s.WslVmMB   -gt $peakWslMB)    { $peakWslMB = $s.WslVmMB }
    if ($s.DockerMB  -gt $peakDockerMB) { $peakDockerMB = $s.DockerMB }
    if ($s.AvailableGB -lt $minAvailable) { $minAvailable = $s.AvailableGB }
    if ($s.AvailableGB -lt $MinAvailableGB) {
      Stop-DockerNow -Why "稳态期可用内存 $($s.AvailableGB)GB 低于阈值"
      $aborted = $true
      break
    }
  }

  if ($steady.Count -gt 0) {
    $medAvail = ($steady | Sort-Object AvailableGB)[[int]($steady.Count / 2)]
    $medCommitted = ($steady | Sort-Object CommittedGB)[[int]($steady.Count / 2)]
    $medWsl = ($steady | Sort-Object WslVmMB)[[int]($steady.Count / 2)]
    $medDocker = ($steady | Sort-Object DockerMB)[[int]($steady.Count / 2)]

    Write-Host ''
    Write-Host '════ 稳态（引擎就绪后中位数） ════' -ForegroundColor Cyan
    Write-Host ("  可用内存   : {0} GB" -f $medAvail.AvailableGB)
    Write-Host ("  已提交     : {0} GB" -f $medCommitted.CommittedGB)
    Write-Host ("  WSL 虚拟机 : {0} MB" -f $medWsl.WslVmMB)
    Write-Host ("  Docker 合计: {0} MB" -f $medDocker.DockerMB)
  }
}

# ── 结论 ────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '════ 开销结论 ════' -ForegroundColor Cyan
Write-Host ("  基线可用内存        : {0} GB" -f $baseline.AvailableGB)
Write-Host ("  过程中最低可用内存  : {0} GB" -f $minAvailable)
Write-Host ("  可用内存净减少      : {0:N2} GB" -f ($baseline.AvailableGB - $minAvailable))
Write-Host ("  WSL 虚拟机峰值      : {0} MB ({1:N2} GB)" -f $peakWslMB, ($peakWslMB / 1024))
Write-Host ("  Docker 进程峰值合计 : {0} MB ({1:N2} GB)" -f $peakDockerMB, ($peakDockerMB / 1024))
Write-Host ("  提交上限            : {0:N2} GB" -f (Get-CommitLimitGB))
Write-Host ("  被安全阀中止        : {0}" -f $aborted)
Write-Host ''
Write-Host "采样明细已存: $env:TEMP\docker-cold.csv / docker-steady.csv"
$cold   | Export-Csv -LiteralPath "$env:TEMP\docker-cold.csv"   -NoTypeInformation -Encoding utf8
if ($engineReady) {
  $steady | Export-Csv -LiteralPath "$env:TEMP\docker-steady.csv" -NoTypeInformation -Encoding utf8
}
