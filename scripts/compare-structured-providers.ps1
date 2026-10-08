# Compare the structured-webpage artifact produced on the two sandbox providers.
#
# The claim under test is "adapted": the same request must yield byte-identical
# deliverable content on LocalSandbox and DockerSandbox. Docker adds a container
# boundary, not a different result.
#
# Both requests are identical except for `provider`, and both run with
# `annotate: false` so that no debug markup differs between them.
#
# ASCII-only on purpose (Windows PowerShell 5.1 parses .ps1 as ANSI without a BOM).
[CmdletBinding()]
param([int] $TimeoutSec = 240)

$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8787'

function Invoke-Run {
  param([string] $RequestFile)
  $path = (Resolve-Path -LiteralPath $RequestFile).Path
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $created = Invoke-RestMethod -Uri "$base/api/runs" -Method Post -Body $bytes `
    -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
  $runId = $created.runId
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    $rec = Invoke-RestMethod -Uri "$base/api/runs/$runId" -TimeoutSec 15
    if ($rec.status -notin @('queued', 'running')) { return $rec }
  }
  throw "run $runId did not finish in time"
}

function Get-ArtifactText {
  param([string] $RunId)
  $dir = Get-ChildItem 'workspaces' -Recurse -Directory -Depth 1 |
    Where-Object { $_.Name -like "$RunId*" } | Select-Object -First 1
  if (-not $dir) { throw "sandbox dir not found for $RunId" }
  $html = Join-Path $dir.FullName 'artifacts\index.html'
  if (-not (Test-Path -LiteralPath $html)) { throw "artifact missing for $RunId" }
  return [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($html))
}

$results = [ordered]@{}
foreach ($name in @('local', 'docker')) {
  Write-Host "=== running on $name ==="
  $rec = Invoke-Run -RequestFile "scripts\demo-request-$name.json"
  $secs = [math]::Round((($rec.finishedAt - $rec.startedAt) / 1000), 2)
  Write-Host ("  runId  : {0}" -f $rec.id)
  Write-Host ("  status : {0}  ({1} s)" -f $rec.status, $secs)
  if ($rec.status -ne 'succeeded') {
    Write-Host ("  reason : {0}" -f $rec.reason)
    Write-Host ("  error  : {0}" -f $rec.error)
  }
  $text = Get-ArtifactText -RunId $rec.id
  Write-Host ("  artifact: {0} chars" -f $text.Length)
  $results[$name] = [ordered]@{ rec = $rec; text = $text; secs = $secs }
}

# --- compare ---------------------------------------------------------------
$local = $results['local']
$docker = $results['docker']

# Normalise the one thing that is *supposed* to differ: the project/run id is
# stamped into `data-ms-project` so a page can be traced back to its run. Two
# different runs therefore legitimately carry two different ids. Comparing raw
# bytes without accounting for that reports a false mismatch (it did: 8 chars).
$normLocal = $local.text -replace 'data-ms-project="[^"]*"', 'data-ms-project="<id>"'
$normDocker = $docker.text -replace 'data-ms-project="[^"]*"', 'data-ms-project="<id>"'

Write-Host ''
Write-Host '=== comparison ==='
Write-Host ("  nodes local  : {0}" -f $local.rec.planSummary.Count)
Write-Host ("  nodes docker : {0}" -f $docker.rec.planSummary.Count)

$planLocal = ($local.rec.planSummary | ForEach-Object { $_.toolId }) -join '>'
$planDocker = ($docker.rec.planSummary | ForEach-Object { $_.toolId }) -join '>'
$planSame = $planLocal -eq $planDocker
Write-Host ("  plan identical : {0}" -f $planSame)

$bytesLocal = [System.Text.Encoding]::UTF8.GetBytes($normLocal)
$bytesDocker = [System.Text.Encoding]::UTF8.GetBytes($normDocker)
$same = ($bytesLocal.Length -eq $bytesDocker.Length)
$firstDiff = -1
if ($same) {
  for ($i = 0; $i -lt $bytesLocal.Length; $i++) {
    if ($bytesLocal[$i] -ne $bytesDocker[$i]) { $same = $false; $firstDiff = $i; break }
  }
}
Write-Host ("  artifact bytes : {0} vs {1}" -f $bytesLocal.Length, $bytesDocker.Length)
Write-Host ("  artifact identical (after normalising run id) : {0}" -f $same)
if (-not $same -and $firstDiff -ge 0) {
  $s = [Math]::Max(0, $firstDiff - 50)
  $len = [Math]::Min(120, $bytesLocal.Length - $s)
  Write-Host ("  first diff @{0}:" -f $firstDiff)
  Write-Host ("    local : {0}" -f $normLocal.Substring($s, $len))
  Write-Host ("    docker: {0}" -f $normDocker.Substring($s, $len))
}

# --- structural sanity on both --------------------------------------------
Write-Host ''
Write-Host '=== structural checks (both providers) ==='
foreach ($name in @('local', 'docker')) {
  $t = $results[$name].text
  $imgs = ([regex]::Matches($t, 'src="data:image/svg\+xml')).Count
  $empty = ([regex]::Matches($t, 'src=""')).Count
  $ext = [regex]::IsMatch($t, '<script[^>]+src=') -or [regex]::IsMatch($t, '<link[^>]+href="https?:')
  $tabs = ([regex]::Matches($t, 'data-ms-tab=')).Count
  $details = ([regex]::Matches($t, '<details')).Count
  $cjk = [regex]::IsMatch($t, '[\u4e00-\u9fff]')
  Write-Host ("  {0,-7} imgs={1} empty-src={2} external={3} tabs={4} details={5} cjk={6}" -f `
      $name, $imgs, $empty, $ext, $tabs, $details, $cjk)
}

if (-not $same) {
  Write-Host ''
  Write-Host 'MISMATCH: providers produced different artifacts'
  exit 1
}
Write-Host ''
Write-Host 'OK: both providers produced byte-identical structured pages'
