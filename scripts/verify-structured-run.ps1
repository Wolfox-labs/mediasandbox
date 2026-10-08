# Verify a structured-run artifact: does the gallery really contain images, and is the page self-contained?
#
# Written as a script file rather than a one-liner because nested quotes get eaten when
# passed through -Command (a previous attempt turned 'src=""' into 'src=', which reported
# six phantom "empty src" hits).
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 files as ANSI unless they carry a
# BOM, so a UTF-8 file with Chinese comments fails to parse ("unexpected token").
[CmdletBinding()]
param([Parameter(Mandatory)][string] $RunIdPrefix)

$ErrorActionPreference = 'Stop'
$dir = Get-ChildItem 'workspaces\local' -Directory |
  Where-Object { $_.Name -like "$RunIdPrefix*" } |
  Select-Object -First 1
if (-not $dir) { throw "sandbox dir not found: $RunIdPrefix" }

$htmlPath = Join-Path $dir.FullName 'artifacts\index.html'
$bytes = [System.IO.File]::ReadAllBytes($htmlPath)
$text = [System.Text.Encoding]::UTF8.GetString($bytes)

Write-Host "sandbox : $($dir.Name)"
Write-Host "artifact: $($text.Length) chars (UTF-8 decoded)"

# --- structure -------------------------------------------------------------
Write-Host ''
Write-Host '=== page structure ==='
[regex]::Matches($text, 'data-ms-block="(b\d+)"[^>]*data-ms-status="(\w+)"[^>]*data-ms-type="([a-z-]+)"') |
  ForEach-Object { Write-Host ('  {0,-4} {1,-12} [{2}]' -f $_.Groups[1].Value, $_.Groups[3].Value, $_.Groups[2].Value) }

# --- src attributes, one by one (this is where the earlier false positive came from) ---
Write-Host ''
Write-Host '=== every src attribute ==='
$empty = 0
$dataUri = 0
foreach ($m in [regex]::Matches($text, 'src="([^"]*)"')) {
  $value = $m.Groups[1].Value
  if ($value.Length -eq 0) {
    $empty += 1
    Write-Host '  [EMPTY] src=""  <-- problem'
  }
  elseif ($value.StartsWith('data:image/')) {
    $dataUri += 1
    $kind = ($value -split ';')[0]
    Write-Host ('  [ok]    {0}  ({1} chars)' -f $kind, $value.Length)
  }
  else {
    Write-Host ('  [ext]   {0}' -f $value)
  }
}
Write-Host "  total: $dataUri data URI, $empty empty"

# --- self-containment ------------------------------------------------------
Write-Host ''
Write-Host '=== self-containment ==='
$checks = [ordered]@{
  'external stylesheet (link href=http)' = '<link[^>]+href="https?:'
  'external script (script src=)'        = '<script[^>]+src='
  'CSS @import'                          = '@import'
  'CSS external url()'                   = 'url\(["'']?https?:'
}
foreach ($kv in $checks.GetEnumerator()) {
  $hit = [regex]::IsMatch($text, $kv.Value)
  $verdict = if ($hit) { 'HIT  <-- problem' } else { 'none' }
  Write-Host ('  {0,-38} {1}' -f $kv.Key, $verdict)
}

# --- interactive elements --------------------------------------------------
Write-Host ''
Write-Host '=== interactive elements ==='
Write-Host "  data-ms-tab   : $(([regex]::Matches($text, 'data-ms-tab=')).Count)"
Write-Host "  data-ms-panel : $(([regex]::Matches($text, 'data-ms-panel=')).Count)"
Write-Host "  <details>     : $(([regex]::Matches($text, '<details')).Count)"
Write-Host "  aria-selected : $(([regex]::Matches($text, 'aria-selected')).Count)"
Write-Host "  inline script : $(([regex]::Matches($text, '<script>')).Count)"

# --- annotation ------------------------------------------------------------
Write-Host ''
Write-Host '=== annotate ==='
Write-Host "  ms-annotate elements: $(([regex]::Matches($text, 'class="ms-annotate"')).Count)"

# --- encoding sanity -------------------------------------------------------
Write-Host ''
Write-Host '=== text encoding ==='
$titleMatch = [regex]::Match($text, '<title>([^<]*)</title>')
Write-Host "  <title>          : $($titleMatch.Groups[1].Value)"
Write-Host "  has CJK          : $([regex]::IsMatch($text, '[\u4e00-\u9fff]'))"
Write-Host "  has U+FFFD       : $([regex]::IsMatch($text, [char]0xFFFD))"
