<#
.SYNOPSIS
  Installs T3-Mods releases over the local T3 Code install.

.DESCRIPTION
  Run by two scheduled tasks (registered with -Mode install): "T3 Mods Updater" every
  10 minutes, and "T3 Mods Updater (wake)" at logon, unlock and resume from sleep.
  Each run:
    1. Reads the latest private release of the mods repo through the GitHub CLI, and takes
       the updater (and task schedule) that ships with it.
    2. Waits until every T3 server (-Servers) has marked the release deployed, so this
       client is never ahead of the servers (after -GateMaxHours it installs anyway).
    3. Reinstalls the mods build if a vanilla T3 Code has replaced it (vanilla ships an
       update feed in resources\app-update.yml; mods builds never do).
    4. Downloads the installer and verifies its SHA-256 against the release manifest.
    5. Waits until T3 Code is idle: not running, or its process tree quiet and no input
       for -IdleMinutes. In the 15 minutes after a wake only local agents hold it back.
    6. Backs up userdata (with the database when the upstream version changes), installs
       silently, relaunches, and health-checks the server. If the check fails it reinstalls
       the previous build and skips the bad release.

.PARAMETER Mode
  check      Default. Install the latest release when idle.
  wake       As check, right after logon, unlock or resume: doesn't wait for input idle.
  now        Install the latest release immediately; closes T3 Code.
  rollback   Reinstall the previous build.
  status     Print the updater state.
  install    Copy this script to %LOCALAPPDATA%\T3ModsUpdater, register the tasks and the
             "T3 Mods - Update now" shortcut, then install the latest release now.
  uninstall  Remove the tasks and the shortcut (downloads, backups and logs are kept).
#>
[CmdletBinding()]
param(
  [ValidateSet("check", "wake", "now", "rollback", "status", "install", "uninstall")]
  [string]$Mode = "check",
  [string]$Repo = "ThomasAsh/T3-Mods",
  [int]$IdleMinutes = 20,
  [string[]]$Servers = @("HD", "HDG"),
  [int]$GateMaxHours = 12
)

$ErrorActionPreference = "Stop"
$Root = Join-Path $env:LOCALAPPDATA "T3ModsUpdater"
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\t3code"
$UserData = Join-Path $env:USERPROFILE ".t3\userdata"
$StatePath = Join-Path $Root "state.json"
$LogPath = Join-Path $Root "updater.log"
$DownloadsDir = Join-Path $Root "downloads"
$BackupsDir = Join-Path $Root "backups"
$KeepBuilds = 3
$KeepBackups = 3
$Script = Join-Path $Root "T3ModsUpdater.ps1"
$TaskName = "T3 Mods Updater"
$WakeTaskName = "T3 Mods Updater (wake)"
# Bump when the tasks change; every run re-registers tasks that carry an older version.
$TaskVersion = "tasks v2"
$Shortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "T3 Mods - Update now.lnk"

New-Item -ItemType Directory -Force -Path $Root, $DownloadsDir, $BackupsDir | Out-Null

function Write-Log([string]$Message) {
  $line = "{0}  {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:sszzz"), $Message
  Add-Content -Path $LogPath -Value $line
  Write-Host $line
  if ((Get-Item $LogPath).Length -gt 1MB) {
    Move-Item -Force $LogPath "$LogPath.1"
  }
}

function Get-State {
  if (Test-Path $StatePath) {
    return Get-Content $StatePath -Raw | ConvertFrom-Json
  }
  return [pscustomobject]@{
    enabled = $false; installedTag = $null; installedVersion = $null; installedAt = $null
    previousTag = $null; badTags = @(); notifiedTag = $null
  }
}

function Save-State($State) {
  $State | ConvertTo-Json -Depth 5 | Set-Content -Path $StatePath -Encoding UTF8
}

# State files written by older updaters lack newer keys; add them on first use.
function Set-StateValue($State, [string]$Name, $Value) {
  $State | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

# Logs a repeating condition once until it changes.
function Write-LogOnce($State, [string]$Message) {
  if ($State.waitingNote -eq $Message) { return }
  Set-StateValue $State "waitingNote" $Message
  Save-State $State
  Write-Log $Message
}

function Get-GhPath {
  $command = Get-Command gh -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  foreach ($candidate in @(
      (Join-Path $env:USERPROFILE "scoop\shims\gh.exe"),
      (Join-Path $env:ProgramFiles "GitHub CLI\gh.exe"))) {
    if (Test-Path $candidate) { return $candidate }
  }
  throw "GitHub CLI (gh) not found"
}

function Invoke-Gh([string[]]$Arguments) {
  $output = & (Get-GhPath) @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "gh $($Arguments -join ' ') failed: $output" }
  return $output
}

function Show-Toast([string]$Title, [string]$Body) {
  try {
    [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $escape = { param($text) [System.Security.SecurityElement]::Escape($text) }
    $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$(& $escape $Title)</text><text>$(& $escape $Body)</text></binding></visual></toast>")
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show(
      [Windows.UI.Notifications.ToastNotification]::new($xml))
  } catch {
    Write-Log "toast failed: $($_.Exception.Message)"
  }
}

# The exe is named after the product, which differs by channel ("T3 Code (Nightly).exe").
function Get-AppExe {
  $exe = Get-ChildItem $InstallDir -Filter "T3 Code*.exe" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike "Uninstall*" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $exe) { throw "no T3 Code executable in $InstallDir" }
  return $exe.FullName
}

# The uninstaller carries the full version ("0.0.46-nightly.20261005.2702"); the app exe does not.
function Get-InstalledVersion {
  $uninstaller = Get-ChildItem $InstallDir -Filter "Uninstall T3 Code*.exe" -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $uninstaller) { return $null }
  return $uninstaller.VersionInfo.ProductVersion
}

# Sortable key: stable X.Y.Z sorts after its own nightlies, nightlies by date and build.
function ConvertTo-VersionKey([string]$Version) {
  if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d{8})\.(\d+))?$') { return $null }
  $stable = 1; $date = 0; $build = 0
  if ($Matches[4]) { $stable = 0; $date = [int]$Matches[4]; $build = [int]$Matches[5] }
  return "{0:D6}{1:D6}{2:D6}{3}{4:D8}{5:D8}" -f [int]$Matches[1], [int]$Matches[2], [int]$Matches[3], $stable, $date, $build
}

function Test-OlderThanInstalled([string]$Tag) {
  $installed = ConvertTo-VersionKey (Get-InstalledVersion)
  $release = ConvertTo-VersionKey ($Tag -replace '^mods-v(.+)-\d+$', '$1')
  return $installed -and $release -and $release -lt $installed
}

function Test-VanillaInstall {
  return Test-Path (Join-Path $InstallDir "resources\app-update.yml")
}

function Get-T3Processes {
  $prefix = $InstallDir.TrimEnd("\") + "\"
  return @(Get-CimInstance Win32_Process | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    })
}

Add-Type -ErrorAction SilentlyContinue -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class T3ModsIdle {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  public static double Minutes() {
    var info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return 0;
    return ((uint)Environment.TickCount - info.dwTime) / 60000.0;
  }
}
"@

function Get-ProcessTreeCpuSeconds([int[]]$RootIds) {
  $all = Get-CimInstance Win32_Process
  $ids = New-Object System.Collections.Generic.HashSet[int]
  foreach ($id in $RootIds) { [void]$ids.Add($id) }
  do {
    $added = $false
    foreach ($process in $all) {
      if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) { $added = $true }
    }
  } while ($added)
  $total = 0.0
  foreach ($id in $ids) {
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($process -and $process.CPU) { $total += $process.CPU }
  }
  return $total
}

# Busy means agents are probably mid-turn: the T3 process tree (server plus provider
# CLIs it spawned) burned more than a little CPU over a short window.
function Test-T3Busy([object[]]$Processes) {
  $ids = @($Processes | ForEach-Object { [int]$_.ProcessId })
  $before = Get-ProcessTreeCpuSeconds $ids
  Start-Sleep -Seconds 20
  $after = Get-ProcessTreeCpuSeconds $ids
  $used = $after - $before
  Write-Log ("T3 process tree used {0:N1}s CPU in 20s" -f $used)
  return $used -gt 2.0
}

function Stop-T3 {
  $processes = Get-T3Processes
  if ($processes.Count -eq 0) { return $false }
  Write-Log "closing T3 Code ($($processes.Count) processes)"
  foreach ($process in $processes) {
    $live = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
    if ($live -and $live.MainWindowHandle -ne 0) { [void]$live.CloseMainWindow() }
  }
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline -and (Get-T3Processes).Count -gt 0) { Start-Sleep -Milliseconds 500 }
  foreach ($process in Get-T3Processes) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  return $true
}

function Backup-UserData([string]$Label, [bool]$IncludeDatabase) {
  if (-not (Test-Path $UserData)) { return }
  $dest = Join-Path $BackupsDir ("{0:yyyyMMdd-HHmmss}-{1}" -f (Get-Date), $Label)
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Get-ChildItem $UserData -File | Where-Object {
    $_.Name -notlike "usage-*" -and ($IncludeDatabase -or $_.Name -notlike "*.sqlite*")
  } | Copy-Item -Destination $dest
  foreach ($dir in @("secrets", "themes")) {
    $source = Join-Path $UserData $dir
    if (Test-Path $source) { Copy-Item -Recurse $source (Join-Path $dest $dir) }
  }
  Write-Log "backed up userdata to $dest (database: $IncludeDatabase)"
  Get-ChildItem $BackupsDir -Directory | Sort-Object Name -Descending |
    Select-Object -Skip $KeepBackups | Remove-Item -Recurse -Force
}

# With Settings > Connections > Local environment off, the app is a client only and
# starts no server, so health means the app is still up a while after launch.
function Test-LocalEnvironmentEnabled {
  $path = Join-Path $UserData "desktop-settings.json"
  if (-not (Test-Path $path)) { return $true }
  try { return (Get-Content $path -Raw | ConvertFrom-Json).localEnvironmentEnabled -ne $false } catch { return $true }
}

function Test-Health([datetime]$SinceUtc) {
  if (-not (Test-LocalEnvironmentEnabled)) {
    Start-Sleep -Seconds 45
    $alive = (Get-T3Processes).Count -gt 0
    Write-Log ("client-only health check: T3 Code {0}" -f $(if ($alive) { "is running" } else { "exited" }))
    return $alive
  }
  $runtimePath = Join-Path $UserData "server-runtime.json"
  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if (-not (Test-Path $runtimePath)) { continue }
    try {
      $runtime = Get-Content $runtimePath -Raw | ConvertFrom-Json
      if ([datetime]::Parse($runtime.startedAt).ToUniversalTime() -lt $SinceUtc) { continue }
      if (-not (Get-Process -Id $runtime.pid -ErrorAction SilentlyContinue)) { continue }
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri "http://127.0.0.1:$($runtime.port)/"
      if ($response.StatusCode -lt 500) { return $true }
    } catch {
      if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -lt 500) { return $true }
    }
  }
  return $false
}

function Get-ReleaseFiles([string]$Tag) {
  $dir = Join-Path $DownloadsDir $Tag
  $manifestPath = Join-Path $dir "mods-manifest.json"
  if (-not (Test-Path $manifestPath)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Write-Log "downloading $Tag"
    # Windows assets only; releases also carry the Linux AppImage and server archive.
    Invoke-Gh @("release", "download", $Tag, "--repo", $Repo, "--dir", $dir, "--clobber",
      "--pattern", "*.exe", "--pattern", "mods-manifest.json", "--pattern", "T3ModsUpdater.ps1") | Out-Null
  }
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  $installer = Join-Path $dir $manifest.installer.name
  $hash = (Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant()
  if ($hash -ne $manifest.installer.sha256) {
    Remove-Item -Recurse -Force $dir
    throw "installer hash mismatch for $Tag"
  }
  Get-ChildItem $DownloadsDir -Directory | Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $KeepBuilds | Remove-Item -Recurse -Force
  return [pscustomobject]@{ Tag = $Tag; Manifest = $manifest; Installer = $installer }
}

function Install-Build($Release) {
  $installStartedUtc = (Get-Date).ToUniversalTime()
  Write-Log "installing $($Release.Tag) ($($Release.Manifest.version), build $($Release.Manifest.build))"
  $process = Start-Process -FilePath $Release.Installer -ArgumentList "/S" -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "installer exited with $($process.ExitCode)" }
  if (Test-VanillaInstall) { throw "installed build still carries an update feed" }
  Start-Process -FilePath (Get-AppExe) | Out-Null
  return Test-Health $installStartedUtc
}

function Install-Release($State, $Release) {
  $previous = if ($State.installedTag) {
    try { Get-ReleaseFiles $State.installedTag } catch { $null }
  } else { $null }
  [void](Stop-T3)
  $upstreamChanged = $State.installedVersion -ne $Release.Manifest.version
  Backup-UserData -Label ("before-" + $Release.Tag) -IncludeDatabase $upstreamChanged

  if (Install-Build $Release) {
    $State.previousTag = $State.installedTag
    $State.installedTag = $Release.Tag
    $State.installedVersion = $Release.Manifest.version
    $State.installedAt = (Get-Date).ToString("o")
    $State.enabled = $true
    Save-State $State
    Write-Log "installed $($Release.Tag)"
    # Self-update: each release carries the updater that matches it; used from the next run.
    $updater = Join-Path (Split-Path $Release.Installer) "T3ModsUpdater.ps1"
    if (Test-Path $updater) { Copy-Item -Force $updater (Join-Path $Root "T3ModsUpdater.ps1") }
    Show-Toast "T3 Code updated" "T3 Code $($Release.Manifest.version) with mods (build $($Release.Manifest.build))."
    return
  }

  Write-Log "health check failed for $($Release.Tag)"
  $State.badTags = @($State.badTags) + $Release.Tag
  Save-State $State
  if ($previous) {
    [void](Stop-T3)
    if (Install-Build $previous) {
      Write-Log "rolled back to $($previous.Tag)"
      Show-Toast "T3 mods update rolled back" "$($Release.Tag) failed its health check; restored $($previous.Tag)."
      return
    }
  }
  Show-Toast "T3 mods update failed" "$($Release.Tag) failed its health check. See $LogPath."
  throw "install of $($Release.Tag) failed and no rollback was possible"
}

function Register-UpdaterTasks {
  $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $user = "$env:USERDOMAIN\$env:USERNAME"
  # conhost --headless runs the script without flashing a console window.
  $action = { param($mode) New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot "System32\conhost.exe") `
      -Argument "--headless `"$powershell`" -NoProfile -ExecutionPolicy Bypass -File `"$Script`" -Mode $mode" }
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $description = "Installs T3-Mods builds over T3 Code once the T3 servers run them. See $Root\updater.log. ($TaskVersion)"

  $every10 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName $TaskName -Action (& $action "check") -Trigger @($every10) `
    -Settings $settings -Principal $principal -Force -Description $description | Out-Null

  $atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
  $atLogon.Delay = "PT1M"
  $sessionClass = Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskSessionStateChangeTrigger
  $atUnlock = New-CimInstance -CimClass $sessionClass -ClientOnly -Property @{ StateChange = 8; UserId = $user; Enabled = $true }
  $wakeTriggers = @($atLogon, $atUnlock)
  try {
    $eventClass = Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskEventTrigger
    $query = "<QueryList><Query Id='0' Path='System'><Select Path='System'>*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]</Select></Query></QueryList>"
    $wakeTriggers += New-CimInstance -CimClass $eventClass -ClientOnly -Property @{ Subscription = $query; Enabled = $true; Delay = "PT30S" }
    Register-ScheduledTask -TaskName $WakeTaskName -Action (& $action "wake") -Trigger $wakeTriggers `
      -Settings $settings -Principal $principal -Force -Description $description | Out-Null
  } catch {
    # Without the resume event, logon and unlock still cover the morning.
    Write-Log "resume-from-sleep trigger unavailable ($($_.Exception.Message)); using logon and unlock"
    Register-ScheduledTask -TaskName $WakeTaskName -Action (& $action "wake") -Trigger @($atLogon, $atUnlock) `
      -Settings $settings -Principal $principal -Force -Description $description | Out-Null
  }

  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($Shortcut)
  $link.TargetPath = $powershell
  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Script`" -Mode now"
  $link.WorkingDirectory = $Root
  $link.Description = "Install the latest T3-Mods build now (closes T3 Code)"
  $appIcon = Join-Path $InstallDir "T3 Code (Nightly).exe"
  if (-not (Test-Path $appIcon)) { $appIcon = Join-Path $InstallDir "T3 Code (Alpha).exe" }
  if (Test-Path $appIcon) { $link.IconLocation = "$appIcon,0" }
  $link.Save()
  Write-Log "registered '$TaskName' (every 10 min) and '$WakeTaskName' (logon, unlock, resume) ($TaskVersion)"
}

function Update-UpdaterTasks {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $wakeTask = Get-ScheduledTask -TaskName $WakeTaskName -ErrorAction SilentlyContinue
  if (-not $task -or -not $wakeTask -or $task.Description -notlike "*($TaskVersion)*") {
    Register-UpdaterTasks
  }
}

# Each release carries the updater that matches it; take it once per release. The new
# copy runs from the next trigger on and brings its own task schedule with it.
function Update-Self($State, [string]$Tag) {
  if ($State.updaterTag -eq $Tag) { return }
  $tmp = Join-Path $env:TEMP ("T3ModsUpdater-{0}.ps1" -f [guid]::NewGuid())
  try {
    Invoke-Gh @("release", "download", $Tag, "--repo", $Repo, "--pattern", "T3ModsUpdater.ps1", "--output", $tmp, "--clobber") | Out-Null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($tmp, [ref]$null, [ref]$errors)
    if ($errors.Count -gt 0) { throw "the release's updater does not parse" }
    if (-not (Test-Path $Script) -or (Get-FileHash $tmp).Hash -ne (Get-FileHash $Script).Hash) {
      Copy-Item -Force $tmp $Script
      Write-Log "updated this updater from $Tag (in use from the next run)"
    }
    Set-StateValue $State "updaterTag" $Tag
    Save-State $State
  } catch {
    Write-Log "updater self-update skipped: $($_.Exception.Message)"
  } finally {
    Remove-Item -Force $tmp -ErrorAction SilentlyContinue
  }
}

$mutex = New-Object System.Threading.Mutex($false, "Local\T3ModsUpdater")
if (-not $mutex.WaitOne(0)) { Write-Host "Another updater run is in progress."; exit 0 }
try {
  $state = Get-State

  if ($Mode -eq "status") {
    $state | Format-List
    Write-Host ("Installed build is {0}" -f $(if (Test-VanillaInstall) { "VANILLA" } else { "modded" }))
    exit 0
  }

  if ($Mode -eq "uninstall") {
    foreach ($name in @($TaskName, $WakeTaskName)) {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    }
    Remove-Item -Force $Shortcut -ErrorAction SilentlyContinue
    Write-Log "removed the scheduled tasks and the shortcut; files in $Root were kept"
    exit 0
  }

  if ($Mode -eq "install") {
    if ($PSCommandPath -and ((Resolve-Path $PSCommandPath).Path -ne $Script)) { Copy-Item -Force $PSCommandPath $Script }
    Register-UpdaterTasks
    $Mode = "now"
  }

  if ($Mode -eq "rollback") {
    if (-not $state.previousTag) { throw "no previous build recorded" }
    $previousRelease = Get-ReleaseFiles $state.previousTag
    $state.badTags = @($state.badTags) + $state.installedTag
    Install-Release $state $previousRelease
    exit 0
  }

  $automatic = $Mode -eq "check" -or $Mode -eq "wake"
  # A wake opens a 15-minute window, in case the servers are still taking the release.
  if ($Mode -eq "wake") { Set-StateValue $state "wokeAt" (Get-Date).ToString("o"); Save-State $state }
  $justWoke = $Mode -eq "wake" -or ($state.wokeAt -and ((Get-Date) - [datetime]::Parse($state.wokeAt)).TotalMinutes -lt 15)
  if ($automatic -and -not $state.enabled) {
    Write-Log "automatic installs are off until the first manual install (-Mode now)"
    exit 0
  }

  $releaseInfo = @(Invoke-Gh @("release", "view", "--repo", $Repo, "--json", "tagName,publishedAt,assets",
      "--jq", ".tagName, .publishedAt, .assets[].name") | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
  $latestTag = $releaseInfo[0]
  $publishedAt = [datetime]::Parse($releaseInfo[1]).ToUniversalTime()
  $assets = @($releaseInfo | Select-Object -Skip 2)
  Update-Self $state $latestTag
  if ($automatic) { Update-UpdaterTasks }
  # A release that failed its health check is skipped until a newer one is published.
  $targetTag = if (@($state.badTags) -contains $latestTag) { $state.installedTag } else { $latestTag }
  $vanilla = Test-VanillaInstall
  if (-not $targetTag) { exit 0 }
  if (-not $vanilla -and $targetTag -eq $state.installedTag) { exit 0 }
  if ($vanilla) { Write-Log "vanilla T3 Code detected over the mods build" }
  # Never downgrade: a vanilla Nightly can be ahead of the newest mods build, and
  # its database may already be migrated past what the older build understands.
  if (Test-OlderThanInstalled $targetTag) {
    Write-LogOnce $state ("installed T3 Code {0} is newer than {1}; waiting for a newer mods build" -f (Get-InstalledVersion), $targetTag)
    exit 0
  }
  # Servers first: a client ahead of its servers gets "server out of date" everywhere.
  $missing = @($Servers | Where-Object { $assets -notcontains "deployed-$_.txt" })
  if ($targetTag -eq $latestTag -and $missing.Count -gt 0) {
    $ageHours = [int]((Get-Date).ToUniversalTime() - $publishedAt).TotalHours
    if ($Mode -eq "now") {
      Write-Log ("installing {0} before {1} took it (now)" -f $targetTag, ($missing -join ", "))
    } elseif ($ageHours -lt $GateMaxHours) {
      Write-LogOnce $state ("{0} is out; waiting for {1} to take it first" -f $targetTag, ($missing -join ", "))
      exit 0
    } else {
      Write-Log ("{0} still not on {1} after {2} h; installing anyway" -f ($missing -join ", "), $targetTag, $ageHours)
    }
  }
  $release = Get-ReleaseFiles $targetTag

  if ($automatic) {
    $running = Get-T3Processes
    if ($running.Count -gt 0) {
      # Just after a wake (logon, unlock, resume) only local agents hold the update back;
      # a client-only machine has none, and its own reconnect burst isn't work.
      $idle = [T3ModsIdle]::Minutes()
      $waiting = if ($justWoke) { (Test-LocalEnvironmentEnabled) -and (Test-T3Busy $running) } else { $idle -lt $IdleMinutes -or (Test-T3Busy $running) }
      if ($waiting) {
        Write-LogOnce $state ("{0} ready; waiting for T3 Code to be idle" -f $release.Tag)
        if ($state.notifiedTag -ne $release.Tag) {
          $state.notifiedTag = $release.Tag
          Save-State $state
          Show-Toast "T3 mods update ready" "$($release.Tag) installs automatically once T3 Code is idle."
        }
        exit 0
      }
    }
  }

  Install-Release $state $release
} catch {
  Write-Log "error: $($_.Exception.Message)"
  exit 1
} finally {
  $mutex.ReleaseMutex()
}
