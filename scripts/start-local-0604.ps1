$ErrorActionPreference = "Stop"

$Root = "D:\crm-cafe24-0604"
$LogDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$RunStamp = Get-Date -Format "yyyyMMdd-HHmmss"
$RunLog = Join-Path $LogDir "start-local-0604-$RunStamp.log"

function Write-RunLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  $line | Tee-Object -FilePath $RunLog -Append
}

Set-Location $Root

Write-RunLog "crm-cafe24-0604 local startup begin"

$env:DATABASE_URL = "postgres://crm:crm@127.0.0.1:5432/crmdb"
$env:PORT = "3000"
$env:SESSION_SECRET = "crm-cafe24-0604-local-session-secret"
$env:PII_ENCRYPTION_KEY = "crm-cafe24-0604-local-pii-key"
$env:BACKUP_ENCRYPTION_KEY = "crm-cafe24-0604-local-backup-key"
$env:SERVE_STATIC = "true"
$env:SEED_ON_BOOT = "true"
$env:SEED_ADMIN_ACCOUNTS_JSON = '[{"loginId":"admin","password":"a1234","name":"관리자","role":"개발자","department":"개발팀"}]'

Write-RunLog "stopping existing listeners on port 3000"
$listeners = netstat -ano |
  Select-String ":3000" |
  ForEach-Object { ($_ -split "\s+")[-1] } |
  Where-Object { $_ -match "^\d+$" -and $_ -ne "0" } |
  Select-Object -Unique
foreach ($pidValue in $listeners) {
  try {
    Stop-Process -Id ([int]$pidValue) -Force -ErrorAction Stop
    Write-RunLog "stopped process $pidValue"
  } catch {
    Write-RunLog "skip stopping process $pidValue: $($_.Exception.Message)"
  }
}

Write-RunLog "starting postgres via docker compose"
docker compose up -d postgres 2>&1 | Tee-Object -FilePath $RunLog -Append

$deadline = (Get-Date).AddSeconds(90)
$health = ""
do {
  Start-Sleep -Seconds 3
  $health = docker inspect -f '{{.State.Health.Status}}' crm-cafe24-0604-postgres 2>$null
  Write-RunLog "postgres health=$health"
  if ($health -eq "healthy") { break }
} while ((Get-Date) -lt $deadline)

if ($health -ne "healthy") {
  throw "PostgreSQL container did not become healthy. Last health='$health'"
}

Write-RunLog "running type check"
npm run check 2>&1 | Tee-Object -FilePath $RunLog -Append

Write-RunLog "running production build"
npm run build 2>&1 | Tee-Object -FilePath $RunLog -Append

Write-RunLog "pushing database schema"
npm run db:push 2>&1 | Tee-Object -FilePath $RunLog -Append

$out = Join-Path $Root "local-0604.out.log"
$err = Join-Path $Root "local-0604.err.log"
Write-RunLog "starting node server"
$server = Start-Process -FilePath "node" -ArgumentList "scripts/cafe24-start.mjs" -WorkingDirectory $Root -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
Write-RunLog "server pid=$($server.Id)"

Start-Sleep -Seconds 8
$healthz = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/healthz" -UseBasicParsing -TimeoutSec 15
Write-RunLog "healthz status=$($healthz.StatusCode)"

$readyz = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/readyz" -UseBasicParsing -TimeoutSec 15
Write-RunLog "readyz status=$($readyz.StatusCode) body=$($readyz.Content)"

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loginBody = @{ loginId = "admin"; password = "a1234" } | ConvertTo-Json
$login = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/auth/login" -Method POST -Body $loginBody -ContentType "application/json" -WebSession $session -UseBasicParsing -TimeoutSec 15
Write-RunLog "login status=$($login.StatusCode)"

$me = Invoke-WebRequest -Uri "http://127.0.0.1:3000/api/auth/me" -WebSession $session -UseBasicParsing -TimeoutSec 15
Write-RunLog "auth/me status=$($me.StatusCode) body=$($me.Content)"

Write-RunLog "crm-cafe24-0604 local startup complete"
