# Installs / removes / reports the "ShadowAI Notifier" scheduled task.
#
# The task starts notifier\run-forever.cmd hidden every time you log in,
# and that launcher restarts the notifier if it ever stops. Nothing needs
# a terminal window left open.
#
#   npm run notifier:install     install and start now
#   npm run notifier:status      is it running? last log lines
#   npm run notifier:uninstall   stop and remove
param([ValidateSet("install", "uninstall", "status")] [string]$Mode = "status")

$ErrorActionPreference = "Stop"
$TaskName = "ShadowAI Notifier"
$Root = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $Root "notifier\run-forever.cmd"
$Log = Join-Path $Root "notifier\logs\notifier.log"

function Stop-Notifier {
  # the launcher loop and its node child
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe' OR Name='node.exe'" |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*notifier\run-forever.cmd*" -or $_.CommandLine -like "*notifier\index.js*" -or $_.CommandLine -like "*notifier/index.js*" -or $_.CommandLine -like "*npm-cli.js*run notifier") } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
}

switch ($Mode) {
  "install" {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node is not on PATH" }
    $action = New-ScheduledTaskAction -Execute "conhost.exe" `
      -Argument "--headless cmd.exe /c `"$Launcher`"" -WorkingDirectory (Split-Path $Launcher)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
      -Principal $principal -Description "Shadow AI Guard email alerts (runs notifier\run-forever.cmd)" -Force | Out-Null
    Stop-Notifier
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Installed '$TaskName': starts at every logon, restarts if it stops."
    Write-Host "Log: $Log"
  }
  "uninstall" {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Stop-Notifier
    Write-Host "Removed '$TaskName' and stopped the notifier."
  }
  "status" {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host "Not installed. Run: npm run notifier:install"; break }
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*notifier\index.js*" }
    Write-Host ("Task:      " + $t.State)
    Write-Host ("Notifier:  " + $(if ($running) { "running (pid " + ($running.ProcessId -join ",") + ")" } else { "not running" }))
    if (Test-Path $Log) { Write-Host "`nLast log lines:"; Get-Content $Log -Tail 8 }
  }
}
