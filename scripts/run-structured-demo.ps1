# Submit one structured-webpage run using a request body read from a UTF-8 JSON file.
#
# Why a file instead of inline text: PowerShell mangles Chinese characters on the way
# into -Body (they become '?'), and a .ps1 with Chinese literals fails to parse under
# Windows PowerShell 5.1 unless it has a BOM. Reading raw bytes from a JSON file avoids
# both problems: the bytes go to the server exactly as written.
#
# ASCII-only on purpose, same reason.
[CmdletBinding()]
param(
  [string] $RequestFile = 'scripts\demo-request.json',
  [int] $TimeoutSec = 90
)

$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8787'

$path = (Resolve-Path -LiteralPath $RequestFile).Path
$bytes = [System.IO.File]::ReadAllBytes($path)
Write-Host "request: $path ($($bytes.Length) bytes, sent as-is)"

$created = Invoke-RestMethod -Uri "$base/api/runs" -Method Post -Body $bytes `
  -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
$runId = $created.runId
Write-Host "runId  : $runId"

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$rec = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  $rec = Invoke-RestMethod -Uri "$base/api/runs/$runId" -TimeoutSec 15
  if ($rec.status -notin @('queued', 'running')) { break }
}
if (-not $rec -or $rec.status -in @('queued', 'running')) { throw 'run did not finish in time' }

$secs = [math]::Round((($rec.finishedAt - $rec.startedAt) / 1000), 2)
Write-Host "status : $($rec.status)  ($secs s)"
if ($rec.reason) { Write-Host "reason : $($rec.reason)" }
if ($rec.error) { Write-Host "error  : $($rec.error)" }

Write-Host ''
Write-Host 'plan nodes:'
$rec.planSummary | ForEach-Object { Write-Host ("  {0,-24} {1}" -f $_.nodeId, $_.toolId) }

Write-Host ''
Write-Host 'artifacts:'
$rec.artifacts | ForEach-Object { Write-Host ("  {0}  {1} bytes" -f $_.path, $_.size) }

Set-Content -Path (Join-Path $env:TEMP 'ms-demo-runid.txt') -Value $runId -Encoding ascii
Write-Host ''
Write-Host 'runId written to %TEMP%\ms-demo-runid.txt'
