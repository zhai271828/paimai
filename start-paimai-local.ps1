$ErrorActionPreference = "Stop"

$projectDir = Join-Path $PSScriptRoot "code"
$serverPort = 3001
$cloudflared = "E:\tools\cloudflared\cloudflared.exe"
$tunnelLog = "E:\tools\cloudflared\paimai-tunnel.log"
$serverOut = Join-Path $projectDir "local-server.out.log"
$serverErr = Join-Path $projectDir "local-server.err.log"

if (-not (Test-Path -LiteralPath $projectDir)) {
  throw "Project directory not found: $projectDir"
}

if (-not (Test-Path -LiteralPath $cloudflared)) {
  throw "cloudflared not found: $cloudflared"
}

function Stop-LocalServerProcesses {
  $allProcesses = @(Get-CimInstance Win32_Process)
  $processById = @{}
  foreach ($process in $allProcesses) {
    $processById[[int]$process.ProcessId] = $process
  }

  $ids = New-Object "System.Collections.Generic.HashSet[int]"
  $listeners = @(Get-NetTCPConnection -LocalPort $serverPort -State Listen -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    [void]$ids.Add([int]$listener.OwningProcess)
  }

  foreach ($process in $allProcesses) {
    $commandLine = [string]$process.CommandLine
    if ($commandLine -match "@auctioneer/server|start:prod|apps[\\/]+server[\\/]+dist[\\/]+index\.js") {
      [void]$ids.Add([int]$process.ProcessId)
    }
  }

  foreach ($seedId in @($ids)) {
    $currentId = [int]$seedId
    while ($processById.ContainsKey($currentId)) {
      $process = $processById[$currentId]
      $commandLine = [string]$process.CommandLine
      if ($currentId -ne $PID -and ($commandLine -match "npm|tsx|@auctioneer/server|start:prod|dist[\\/]+index\.js|src[\\/]+index\.ts")) {
        [void]$ids.Add($currentId)
        $currentId = [int]$process.ParentProcessId
      } else {
        break
      }
    }
  }

  foreach ($processId in @($ids) | Sort-Object -Descending) {
    if ($processId -ne $PID) {
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
  }

  Start-Sleep -Seconds 2
}

function Test-LocalHealth {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$serverPort/health" -TimeoutSec 5
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Invoke-ProdBuild {
  Write-Host "Building latest server and web assets..."
  & "E:\node.js\npm.cmd" run build:prod --prefix $projectDir
  if ($LASTEXITCODE -ne 0) {
    throw "Build failed with exit code $LASTEXITCODE"
  }
}

Stop-LocalServerProcesses
Invoke-ProdBuild

if (-not (Test-LocalHealth)) {
  $env:NODE_ENV = "production"
  $env:HOST = "127.0.0.1"
  $env:PORT = "$serverPort"
  $env:AUCTIONEER_ALLOWED_ORIGINS = "https://belveth.xyz,https://www.belveth.xyz,http://127.0.0.1:3001,http://localhost:3001,http://127.0.0.1:5173,http://localhost:5173"
  $env:AUCTIONEER_REPOSITORY = "sqlite"
  $env:AUCTIONEER_DATA_DIR = "data/rooms"
  $env:AUCTIONEER_SQLITE_PATH = "data/rooms/auctioneer.sqlite"
  $env:AUCTIONEER_STATIC_DIR = "apps/web/dist"

  Start-Process `
    -FilePath "E:\node.js\npm.cmd" `
    -ArgumentList @("run", "start:prod") `
    -WorkingDirectory $projectDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $serverOut `
    -RedirectStandardError $serverErr

  Start-Sleep -Seconds 5
}

if (-not (Test-LocalHealth)) {
  Write-Host "Game server did not pass health check. See logs:"
  Write-Host $serverOut
  Write-Host $serverErr
  exit 1
}

$cloudflaredRunning = Get-Process cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflaredRunning) {
  $env:TUNNEL_TOKEN = "eyJhIjoiYTMzM2Y2MzRjNDQ5MTNkYzg0M2NkMzJiNjlkYjBjMjUiLCJ0IjoiOGZiODlhNjItMWMwMi00ODdlLTg1NmYtNWI2NjI4NGU5MzFkIiwicyI6IllXVTVZakpoTVRBdE1EUTVZeTAwWXpSaExUZ3pORGN0TlRJeFlqTmlaV0V3T1dNMyJ9"
  Remove-Item -LiteralPath $tunnelLog -Force -ErrorAction SilentlyContinue

  Start-Process `
    -FilePath $cloudflared `
    -ArgumentList @("tunnel", "--no-autoupdate", "--logfile", $tunnelLog, "--loglevel", "info", "run") `
    -WindowStyle Hidden

  Start-Sleep -Seconds 8
}

$cloudflaredRunning = Get-Process cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflaredRunning) {
  Write-Host "Cloudflare Tunnel did not start. See log:"
  Write-Host $tunnelLog
  exit 1
}

Write-Host "Paimai local server is running."
Write-Host "Local health: http://127.0.0.1:$serverPort/health"
Write-Host "Public URL:   https://belveth.xyz"
Write-Host "Tunnel log:   $tunnelLog"
