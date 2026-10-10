# SoMeme — Task Scheduler registration (run this yourself; it creates persistent scheduled tasks)
#   powershell -ExecutionPolicy Bypass -File install-task.ps1            # install
#   powershell -ExecutionPolicy Bypass -File install-task.ps1 -Remove    # uninstall
# Creates:
#   SoMeme Server      — starts the dashboard server at logon
#   SoMeme Tick        — every 30 min: runs due missions (daily slots + new-trend triggers)
#   SoMeme TrendScout  — 08:00 and 16:00 daily: refreshes the trend feed
param([switch]$Remove)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source

if ($Remove) {
  foreach ($t in 'SoMeme Server','SoMeme Tick','SoMeme TrendScout AM','SoMeme TrendScout PM') {
    schtasks /Delete /TN $t /F 2>$null
  }
  Write-Host "SoMeme scheduled tasks removed."
  exit 0
}

schtasks /Create /F /TN "SoMeme Server" /SC ONLOGON /TR "`"$node`" `"$root\server.js`""
schtasks /Create /F /TN "SoMeme Tick" /SC MINUTE /MO 30 /TR "`"$node`" `"$root\engine\mission-run.js`" --tick"
schtasks /Create /F /TN "SoMeme TrendScout AM" /SC DAILY /ST 08:00 /TR "`"$node`" `"$root\engine\trend-scout.js`""
schtasks /Create /F /TN "SoMeme TrendScout PM" /SC DAILY /ST 16:00 /TR "`"$node`" `"$root\engine\trend-scout.js`""

Write-Host ""
Write-Host "Installed. Verify with:  Start-ScheduledTask -TaskName 'SoMeme Server'"
Write-Host "Dashboard: http://127.0.0.1:8797"
