<#
.SYNOPSIS
  Installs (or removes) the T3 Mods Updater for the current user.

.DESCRIPTION
  Copies T3ModsUpdater.ps1 to %LOCALAPPDATA%\T3ModsUpdater and registers the
  "T3 Mods Updater" scheduled task: at logon and every 30 minutes, hidden, as the
  current user, with no elevation. Also adds a Start Menu shortcut,
  "T3 Mods - Update now", which installs the latest build immediately.

  The task stays passive until the first manual install (T3ModsUpdater.ps1 -Mode now).

.PARAMETER Uninstall
  Remove the task and the shortcut. Downloads, backups and logs are kept.
#>
[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$TaskName = "T3 Mods Updater"
$Root = Join-Path $env:LOCALAPPDATA "T3ModsUpdater"
$Script = Join-Path $Root "T3ModsUpdater.ps1"
$Shortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "T3 Mods - Update now.lnk"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -Force $Shortcut -ErrorAction SilentlyContinue
  Write-Host "Removed the '$TaskName' task and shortcut. Files in $Root were kept."
  exit 0
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "T3ModsUpdater.ps1") $Script

$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
# conhost --headless runs the script without flashing a console window.
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot "System32\conhost.exe") `
  -Argument "--headless `"$powershell`" -NoProfile -ExecutionPolicy Bypass -File `"$Script`" -Mode check"
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$atLogon.Delay = "PT5M"
$every30 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 30)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atLogon, $every30) `
  -Settings $settings -Principal $principal -Force `
  -Description "Installs T3-Mods builds over T3 Code when idle. See $Root\updater.log." | Out-Null

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($Shortcut)
$link.TargetPath = $powershell
$link.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Script`" -Mode now"
$link.WorkingDirectory = $Root
$link.Description = "Install the latest T3-Mods build now (closes T3 Code)"
$appIcon = Join-Path $env:LOCALAPPDATA "Programs\t3code\T3 Code (Alpha).exe"
if (Test-Path $appIcon) { $link.IconLocation = "$appIcon,0" }
$link.Save()

Write-Host "Installed '$TaskName' (every 30 min and at logon) and the 'T3 Mods - Update now' shortcut."
Write-Host "Automatic installs begin after the first manual install:"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$Script`" -Mode now"
