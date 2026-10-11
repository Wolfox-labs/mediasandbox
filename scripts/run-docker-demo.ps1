# Start MediaSandbox from YOUR OWN terminal, with Docker-backed features enabled.
#
# Why this script exists:
#   DSH tool processes run at Low integrity (see `whoami /groups`:
#   "Mandatory Label\Low Mandatory Level"). Windows Mandatory Integrity Control
#   blocks Low-integrity processes from opening Docker's named pipe, so any
#   node.exe started by the harness fails with:
#
#       connect EPERM //./pipe/docker_engine
#
#   Measured on this machine: docker.exe (native, Medium) connects fine;
#   python.exe can open the pipe; node.exe started by DSH (Low) is always EPERM.
#   A plain terminal is Medium integrity, so the server works there.
#
# ASCII-only on purpose: Windows PowerShell 5.1 parses .ps1 as ANSI without a BOM,
# and non-ASCII text inside string literals breaks the parser.

$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "=== MediaSandbox (Docker, real browser) ===" -ForegroundColor Cyan
Write-Host "repo: $RepoRoot"

# Docker CLI is not on PATH by default on this machine.
$dockerBin = Join-Path ${env:ProgramFiles} 'Docker\Docker\resources\bin'
if ((Test-Path $dockerBin) -and ($env:PATH -notlike "*$dockerBin*")) {
    $env:PATH = "$dockerBin;$env:PATH"
}

$docker = Join-Path $dockerBin 'docker.exe'
if (-not (Test-Path $docker)) { $docker = 'docker' }

# The engine must be up.
$server = (& $docker version --format '{{.Server.Version}}' 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $server -or $server -match 'error') {
    Write-Host "Docker engine is not up. Start Docker Desktop, wait for it to settle, then rerun." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}
Write-Host "docker engine: $server" -ForegroundColor Green

# The four images must be present.
Write-Host "images:" -ForegroundColor Green
& $docker images --filter 'reference=mediasandbox/*' --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'

# node: this machine has no system node; Node 24.21.0 lives in the workspace.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    foreach ($candidate in @('D:\github123\_tools\node\node.exe')) {
        if (Test-Path $candidate) { $node = $candidate; break }
    }
}
if (-not $node) {
    Write-Host "node.exe not found. Install Node, or edit the node path in this script." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}
Write-Host "node: $node" -ForegroundColor Green

$port = if ($env:PORT) { $env:PORT } else { '8787' }
Write-Host ""
Write-Host "server:  http://127.0.0.1:$port/" -ForegroundColor Yellow
Write-Host "demo:    submit a run with envType=webpage and 'screenshot' ticked,"
Write-Host "         then check the preview and artifacts/screenshot.png,"
Write-Host "         then press the 'interaction verification' button."
Write-Host "stop:    Ctrl-C in this window"
Write-Host ""

# Run the server in the foreground, same environment as `pnpm start`.
& $node --env-file-if-exists=.env 'packages/server/dist/main.js'
