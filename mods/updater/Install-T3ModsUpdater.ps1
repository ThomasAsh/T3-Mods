<#
.SYNOPSIS
  Installs (or removes) the T3 Mods Updater for the current user.

.DESCRIPTION
  Runs T3ModsUpdater.ps1 -Mode install, which copies the updater to
  %LOCALAPPDATA%\T3ModsUpdater, registers its scheduled tasks ("T3 Mods Updater" every
  10 minutes, "T3 Mods Updater (wake)" at logon, unlock and resume) and the
  "T3 Mods - Update now" shortcut, then installs the latest release (closes T3 Code if
  it needs to). Later releases bring their own updater and task schedule.

.PARAMETER Uninstall
  Remove the tasks and the shortcut. Downloads, backups and logs are kept.
#>
[CmdletBinding()]
param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$mode = if ($Uninstall) { "uninstall" } else { "install" }
& (Join-Path $PSScriptRoot "T3ModsUpdater.ps1") -Mode $mode
