<#
  setup.ps1 - McAfk Bot Windows launcher
  Downloads/installs every prerequisite, then runs the bot.
  Called by run.bat (which bypasses the execution policy).
#>
$ErrorActionPreference = 'Stop'

# Always operate from the folder this script lives in.
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    [X] $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 1. Node.js
# ---------------------------------------------------------------------------
Write-Step "Checking Node.js..."

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    # It may be installed but not on the current session's PATH.
    $np = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path $np) {
        $env:PATH = "$env:ProgramFiles\nodejs;$env:PATH"
        $node = Get-Command node -ErrorAction SilentlyContinue
    }
}

if (-not $node) {
    Write-Warn "Node.js not found. Installing it now (this may take a minute)..."

    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host "    Using winget to install Node.js LTS..."
        winget install -e --id OpenJS.NodeJS.LTS --silent `
            --accept-package-agreements --accept-source-agreements | Out-Host
    } else {
        # Fall back to downloading the official LTS MSI directly.
        $base = 'https://nodejs.org/dist/latest-lts-windows-x64/'
        try {
            $links  = (Invoke-WebRequest -Uri $base -UseBasicParsing).Links
            $msiName = ($links | Where-Object { $_.href -like '*.msi' } |
                        Select-Object -First 1).href
            if (-not $msiName) { throw "no MSI link found on $base" }
        } catch {
            Write-Err "Could not reach nodejs.org to download Node.js."
            Write-Err "Please install it manually from https://nodejs.org and run this again."
            Read-Host "Press Enter to exit"
            exit 1
        }
        $msiUrl  = $base.TrimEnd('/') + '/' + $msiName
        $msiPath = Join-Path $env:TEMP 'node-lts.msi'
        Write-Host "    Downloading $msiUrl"
        Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
        Write-Host "    Installing..."
        Start-Process msiexec -ArgumentList '/i', """$msiPath""", '/qn', `
            'REBOOT=ReallySuppress' -Wait
    }

    # Refresh PATH so the just-installed node is visible in this session.
    $env:PATH = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') +
                ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Get-Command node -ErrorAction SilentlyContinue

    if (-not $node) {
        Write-Err "Node.js install finished but 'node' is still not on PATH."
        Write-Err "Restart your PC once, then run run.bat again."
        Read-Host "Press Enter to exit"
        exit 1
    }
}
Write-Ok ("Node.js " + (node --version) + " ready")

# ---------------------------------------------------------------------------
# 2. npm dependencies
# ---------------------------------------------------------------------------
Write-Step "Checking dependencies (grammy, mineflayer)..."
$needInstall = $true
if (Test-Path (Join-Path $ProjectDir 'node_modules')) {
    if ((Test-Path (Join-Path $ProjectDir 'node_modules\grammy')) -and
        (Test-Path (Join-Path $ProjectDir 'node_modules\mineflayer'))) {
        $needInstall = $false
    }
}
if ($needInstall) {
    Write-Host "    Downloading npm packages (this can take a while)..."
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Write-Err "npm install failed. Check your internet connection and try again."
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Ok "Dependencies installed"
} else {
    Write-Ok "Dependencies already present"
}

# ---------------------------------------------------------------------------
# 3. .env with Telegram token
# ---------------------------------------------------------------------------
Write-Step "Checking .env configuration..."
$envFile  = Join-Path $ProjectDir '.env'
$tokenOk  = $false
if (Test-Path $envFile) {
    # Read line-by-line so trailing CRLF (\r) can't be mistaken for a value.
    foreach ($line in (Get-Content $envFile)) {
        if ($line -match '^TELEGRAM_BOT_TOKEN\s*=\s*\S') { $tokenOk = $true; break }
    }
}

if (-not $tokenOk) {
    if (-not (Test-Path $envFile)) {
        # Create a fresh .env with the same defaults the project ships with.
        @(
            'TELEGRAM_BOT_TOKEN='
            'USE_PROXY=true'
            'PROXY_FILE=proxies.txt'
            'PROXY_MODE=round-robin'
            'PROXY_DEFAULT_TYPE=socks5'
        ) | Set-Content $envFile -Encoding utf8
    }
    Write-Warn "TELEGRAM_BOT_TOKEN is missing."
    $token = Read-Host "    Paste your Telegram bot token (from @BotFather)"
    if ($token -match '\S') {
        $lines    = Get-Content $envFile
        $replaced = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match '(?m)^\s*TELEGRAM_BOT_TOKEN\s*=') {
                $lines[$i] = "TELEGRAM_BOT_TOKEN=$token"
                $replaced  = $true
                break
            }
        }
        if (-not $replaced) { $lines += "TELEGRAM_BOT_TOKEN=$token" }
        $lines | Set-Content $envFile -Encoding utf8
        Write-Ok "Token saved to .env"
    } else {
        Write-Err "No token provided - the bot cannot start without TELEGRAM_BOT_TOKEN."
        Read-Host "Press Enter to exit"
        exit 1
    }
} else {
    Write-Ok ".env is configured"
}

# ---------------------------------------------------------------------------
# 4. Run the bot
# ---------------------------------------------------------------------------
Write-Step "Starting the bot..."
Write-Host "    (Press Ctrl+C to stop)`n" -ForegroundColor White
node index.js
