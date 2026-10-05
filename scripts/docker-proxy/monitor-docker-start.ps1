#Requires -Version 7.0
<#
.SYNOPSIS
  在监控下启动 Docker Desktop，逐秒采样内存，定位真正的内存消耗者。

.DESCRIPTION
  区分三个容易混淆的指标：
    FreePhysicalMemory  空闲物理内存。文件缓存也算"被占用"，会低估真实可用量。
    Available MBytes    任务管理器的"可用"。含可即时回收的缓存，是真实压力指标。
    Committed Bytes     已提交虚拟内存。超过物理内存才会真正触发换页与 OOM。

  单个进程工作集在采样点最大者会被记录，用于定位消耗者。

  安全阀：可用内存低于阈值立即杀掉 Docker 并退出，绝不把系统顶到 OOM。
#>
[CmdletBinding()]
param(
  [int]    $TimeoutSec      = 240,
  [double] $MinAvailableGB  = 5.0,
  [string] $OutFile         = ''
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$DockerExe = Join-Path ${env:ProgramFiles} 'Docker\Docker\Docker Desktop.exe'

function Resolve-DockerExe {
  # Docker Desktop 装完默认不把 bin 目录写进 PATH，这里按常见安装位置兜底查找。
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

function Get-Snapshot {
  $os       = Get-CimInstance Win32_OperatingSystem
  $freeGB   = $os.FreePhysicalMemory / 1MB
  $totalGB  = $os.TotalVisibleMemorySize / 1MB
  $availCounter = (Get-Counter '\Memory\Available MBytes' -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue
  $availGB  = if ($availCounter) { $availCounter / 1024 } else { $freeGB }
  $commitGB = $os.TotalVirtualMemorySize / 1MB
  $commitLimitGB = $os.TotalVirtualMemorySize / 1MB
  $committedGB   = ($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) / 1MB

  $top = Get-Process -ErrorAction SilentlyContinue |
    Sort-Object WorkingSet64 -Descending |
    Select-Object -First 5 @{n='name';e={$_.ProcessName}}, @{n='mb';e={[int]($_.WorkingSet64/1MB)}}

  [pscustomobject]@{
    Time        = (Get-Date).ToString('HH:mm:ss')
    FreeGB      = [math]::Round($freeGB, 2)
    AvailableGB = [math]::Round($availGB, 2)
    CommittedGB = [math]::Round($committedGB, 2)
    TotalGB     = [math]::Round($totalGB, 2)
    Top         = ($top | ForEach-Object { "$($_.name):$($_.mb)MB" }) -join ' '
  }
}

function Stop-DockerNow {
  param([string] $Why)
  Write-Host "!! $Why" -ForegroundColor Red
  foreach ($n in @('Docker Desktop', 'com.docker.backend', 'com.docker.build')) {
    Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  & wsl.exe --terminate docker-desktop 2>$null | Out-Null
}

$baseline = Get-Snapshot
Write-Host "基线  空闲=$($baseline.FreeGB)GB 可用=$($baseline.AvailableGB)GB 已提交=$($baseline.CommittedGB)GB" -ForegroundColor Cyan
Write-Host ''

Write-Host '启动 Docker Desktop...' -ForegroundColor Cyan
Start-Process -FilePath $DockerExe | Out-Null

$samples = [System.Collections.Generic.List[object]]::new()
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$minAvail = [double]::MaxValue
$minAvailSample = $null
$engineReady = $false
$aborted = $false

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $s = Get-Snapshot
  $samples.Add($s)

  if ($s.AvailableGB -lt $minAvail) {
    $minAvail = $s.AvailableGB
    $minAvailSample = $s
  }

  Write-Host ("{0}  空闲={1,5}GB  可用={2,5}GB  已提交={3,5}GB  | {4}" -f `
    $s.Time, $s.FreeGB, $s.AvailableGB, $s.CommittedGB, $s.Top)

  if ($s.AvailableGB -lt $MinAvailableGB) {
    Stop-DockerNow -Why "可用内存 $($s.AvailableGB)GB 低于阈值 $MinAvailableGB GB，已中止 Docker"
    $aborted = $true
    break
  }

  $v = & $DockerBin version --format '{{.Server.Version}}' 2>$null
  if ($LASTEXITCODE -eq 0 -and $v) {
    Write-Host ''
    Write-Host "引擎就绪：$v" -ForegroundColor Green
    $engineReady = $true
    break
  }
}

Write-Host ''
Write-Host '════ 结论 ════' -ForegroundColor Cyan
Write-Host "引擎就绪      : $engineReady"
Write-Host "被安全阀中止  : $aborted"
Write-Host "最低可用内存  : $minAvail GB"
if ($minAvailSample) {
  Write-Host "该时刻空闲    : $($minAvailSample.FreeGB) GB"
  Write-Host "该时刻已提交  : $($minAvailSample.CommittedGB) GB"
  Write-Host "该时刻 TOP5   : $($minAvailSample.Top)"
}

if ($OutFile) {
  $samples | Export-Csv -LiteralPath $OutFile -NoTypeInformation -Encoding utf8
  Write-Host "采样已存: $OutFile"
}
