param(
  [string]$HostName = "0.0.0.0",
  [int]$Port = 3001,
  [string]$Origin = "http://localhost:3001"
)

$ErrorActionPreference = "Stop"

$env:NODE_ENV = "production"
$env:HOST = $HostName
$env:PORT = "$Port"
$env:AUCTIONEER_ALLOWED_ORIGINS = $Origin
$env:AUCTIONEER_REPOSITORY = "sqlite"
$env:AUCTIONEER_DATA_DIR = "data/rooms"
$env:AUCTIONEER_SQLITE_PATH = "data/rooms/auctioneer.sqlite"
$env:AUCTIONEER_STATIC_DIR = "apps/web/dist"

Write-Host "Building latest production assets..."
npm run build:prod
if ($LASTEXITCODE -ne 0) {
  throw "Build failed with exit code $LASTEXITCODE"
}

npm run start:prod
