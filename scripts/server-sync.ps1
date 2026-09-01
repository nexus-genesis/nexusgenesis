# server-sync.ps1 - check / update the nexus-genesis.top production server (/opt/nexusgenesis)
#
# Usage (run from repo root, PowerShell):
#   .\scripts\server-sync.ps1                     # read-only check: local / remote commit + how far server lagged
#   .\scripts\server-sync.ps1 -Update             # check, then align server to origin/<Branch> + pm2 restart
#
# Optional params:
#   -Key      ssh private key  (default %USERPROFILE%\.ssh\ng_deploy)
#   -Host_    server user@host (default root@nexus-genesis.top)
#   -Remote   git remote name  (default origin)
#   -Branch   git branch       (default master)
#   -AppDir   server app dir   (default /opt/nexusgenesis)
#   -Pm2App   pm2 process name (default nexusgenesis-genesis)
#
# Design:
#   - Default is READ-ONLY: never touches the server (minimum surprise on prod).
#   - -Update performs: server git fetch + reset to remote branch + pm2 restart.
#   - All remote commands run non-interactively (BatchMode) so nothing hangs.
#   - Non-zero exit on any durable diff, so CI / manual callers can detect failure.

[CmdletBinding()]
param(
    [switch]   $Update,
    [string]   $Key    = (Join-Path $env:USERPROFILE '.ssh\ng_deploy'),
    [string]   $Host_  = 'root@nexus-genesis.top',
    [string]   $Remote = 'origin',
    [string]   $Branch = 'master',
    [string]   $AppDir = '/opt/nexusgenesis',
    [string]   $Pm2App = 'nexusgenesis-genesis'
)

$ErrorActionPreference = 'Stop'

# Run a command on the remote box under its login shell (non-interactive).
function Invoke-Remote {
    param([string]$Cmd)
    # Build the single remote command string explicitly; each array element is passed
    # to ssh as its own argv entry so the command string stays intact (no quote mangling).
    $remoteArgs = @('-T', '-i', $Key, '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new', $Host_, ('cd ' + $AppDir + ' && ' + $Cmd))
    $remote = (& ssh @remoteArgs 2>$null) | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-Warning ('remote command failed (exit ' + $LASTEXITCODE + '): ' + $Cmd)
        return $null
    }
    return (($remote -split "`r?`n") | Where-Object { $_ })
}

function Get-LocalHead    { (git rev-parse --short HEAD 2>$null) }
function Get-RemoteHeadOnGithub {
    git fetch origin --quiet 2>$null
    (git rev-parse --short ("$Remote/$Branch") 2>$null)
}

Write-Host '=== NexusGenesis server sync check ===' -ForegroundColor Cyan
Write-Host ('  server : ' + $Host_)
Write-Host ('  app    : ' + $AppDir + '   (pm2: ' + $Pm2App + ')')
Write-Host ('  key    : ' + $Key + '   [exists: ' + (Test-Path $Key) + ']')

$localHead = Get-LocalHead
$ghHead    = Get-RemoteHeadOnGithub
Write-Host ('[local]    HEAD      = ' + $localHead + $(if (-not $localHead) { ' (read failed)' }))
Write-Host ('[github]   ' + $Remote + '/' + $Branch + ' = ' + $ghHead + $(if (-not $ghHead) { ' (read failed)' }))

# ---- read-only remote probing ------------------------------------------------
Write-Host '[remote]   connecting (read-only)... ' -NoNewline
$srvHead   = Invoke-Remote -Cmd 'git rev-parse --short HEAD 2>/dev/null'
$srvStatus = Invoke-Remote -Cmd 'git status -sb | head -n 5'
$srvNeeds  = Invoke-Remote -Cmd ('git rev-list --count HEAD..' + $Remote + '/' + $Branch + ' 2>/dev/null')
$srvExtra  = Invoke-Remote -Cmd ('git rev-list --count ' + $Remote + '/' + $Branch + '..HEAD 2>/dev/null')
$pm2Line   = Invoke-Remote -Cmd ('pm2 describe ' + $Pm2App + ' 2>/dev/null | grep -E ''^(status|uptime|restarts|script)'' | head -n 6')

if (-not $srvHead) {
    Write-Host 'FAIL (cannot reach server HEAD / ssh)'
    exit 1
}
Write-Host 'OK'
Write-Host ('[remote]   HEAD=' + $srvHead + '   behind=' + $srvNeeds + ' / ahead=' + $srvExtra)
Write-Host '          worktree:'
$srvStatus | ForEach-Object { Write-Host ('            ' + $_) }
if ($pm2Line) {
    Write-Host '        pm2:'
    $pm2Line | ForEach-Object { Write-Host ('            ' + $_) }
}
if ($ghHead) {
    $aligned = ($srvHead -eq $ghHead)
    Write-Host ('        align: ' + $(if ($aligned) { 'server == github (in sync)' } else { 'server != github (needs sync)' }))
}

# ---- read-only mode ends here -----------------------------------------------------
if (-not $Update) {
    Write-Host ''
    Write-Host '[note] read-only check; server untouched.' -ForegroundColor Yellow
    Write-Host '        to sync run:  .\scripts\server-sync.ps1 -Update' -ForegroundColor Cyan
    exit 0
}

# ---- update mode ----------------------------------------------------------------
Write-Host ''
Write-Host '=== syncing (-Update) ===' -ForegroundColor Yellow
if (-not $localHead -or -not $ghHead) {
    Write-Host 'local/github HEAD read failed; abort sync.' -ForegroundColor Red
    exit 1
}

# 1) fetch + hard align server to remote branch (drop any local stale changes).
Write-Host '[1/3] server git fetch + reset -> ' + $Remote + '/' + $Branch + ' ... ' -NoNewline
if (-not (Invoke-Remote -Cmd ('git fetch ' + $Remote + ' && git reset --hard ' + $Remote + '/' + $Branch + ' 2>&1 && git submodule update --init --recursive 2>/dev/null; true'))) {
    Write-Host 'FAIL' -ForegroundColor Red
    exit 1
}
Write-Host 'OK'

# 2) restart pm2 so new code takes effect (pm2 keeps startup env).
Write-Host '[2/3] ' + $Pm2App + ' restart ... ' -NoNewline
if (-not (Invoke-Remote -Cmd ('pm2 restart ' + $Pm2App + ' >/dev/null 2>&1 && pm2 save >/dev/null 2>&1; echo done'))) {
    Write-Host 'FAIL' -ForegroundColor Red
    exit 1
}
Write-Host 'OK'

# 3) wait + health check.
Start-Sleep -Seconds 3
Write-Host '[3/3] waiting + checking /health ... ' -NoNewline
$newHead = Invoke-Remote -Cmd 'git rev-parse --short HEAD'
$url = 'https://' + $Host_.Substring($Host_.IndexOf('@') + 1) + '/health'
$health = $null
try { $health = (Invoke-RestMethod -Uri $url -TimeoutSec 15).success } catch { $health = $null }
$ok = ($newHead -eq $ghHead) -and ($health -eq $true)
if ($ok) {
    Write-Host ('OK  (server=' + $newHead + ' == github=' + $ghHead + ', /health online)') -ForegroundColor Green
} else {
    Write-Host 'review needed' -ForegroundColor Red
    Write-Host ('        server=' + $newHead + ' github=' + $ghHead + ' /health=' + $health)
    exit 1
}
Write-Host ''
Write-Host 'done.' -ForegroundColor Green