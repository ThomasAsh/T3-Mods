#!/usr/bin/env bash
# T3 Mods Updater for Linux desktops. Installs T3-Mods releases (the modded T3 Code
# AppImage) for the current user and keeps them current; the Linux counterpart of
# T3ModsUpdater.ps1.
#
#   t3-mods-updater.sh install    once per machine: install this script, a systemd user
#                                 timer (every 30 min and 5 min after login), the
#                                 "T3 Code" launcher, and the latest build
#   t3-mods-updater.sh check      what the timer runs: install the latest release when idle
#   t3-mods-updater.sh now        install the latest release now (closes T3 Code)
#   t3-mods-updater.sh rollback   reinstall the previous build
#   t3-mods-updater.sh status     print the updater state
#   t3-mods-updater.sh uninstall  remove the timer and launcher (keeps the app and backups)
#
# Needs the GitHub CLI (gh) signed in to an account that can read the private repo.
# Each run reads the latest release, verifies the AppImage's SHA-256 against the
# release manifest, never installs a build older than the newest T3 Code this user has
# run (the database migrates one way), waits until T3 Code is idle, backs up userdata,
# swaps the AppImage, and health-checks it, rolling back if the check fails.
#
# Logs: ~/.local/share/t3-mods/updater.log
set -euo pipefail

REPO="${T3MODS_REPO:-ThomasAsh/T3-Mods}"
IDLE_MINUTES="${T3MODS_IDLE_MINUTES:-20}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
ROOT="$DATA_HOME/t3-mods"
APP="$ROOT/app/T3-Code.AppImage"
PREVIOUS_APP="$ROOT/app/T3-Code.previous.AppImage"
SELF="$ROOT/t3-mods-updater.sh"
STATE="$ROOT/state"
LOG="$ROOT/updater.log"
DOWNLOADS="$ROOT/downloads"
BACKUPS="$ROOT/backups"
VANILLA="$ROOT/vanilla"
ICON="$ROOT/t3code.png"
USERDATA="${T3CODE_HOME:-$HOME/.t3}/userdata"
DESKTOP_FILE="$DATA_HOME/applications/t3code.desktop"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
KEEP_BUILDS=3
KEEP_BACKUPS=3
# systemd user services start with a minimal PATH.
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/snap/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"

mkdir -p "$ROOT/app" "$DOWNLOADS" "$BACKUPS"

log() {
  local line
  line="$(date '+%F %T%z')  $*"
  echo "$line" >> "$LOG"
  echo "$line" >&2
  if [ "$(stat -c %s "$LOG")" -gt 1048576 ]; then mv -f "$LOG" "$LOG.1"; fi
}
notify() { command -v notify-send > /dev/null && notify-send -a "T3 Mods Updater" "$1" "$2" 2> /dev/null || true; }
die() { log "error: $*"; exit 1; }

# --- state (key=value, sourced) -------------------------------------------------------
enabled=0 installed_tag="" installed_version="" previous_tag="" bad_tags="" notified_tag="" highest_version=""
# shellcheck source=/dev/null
[ -f "$STATE" ] && . "$STATE"
save_state() {
  local key
  for key in enabled installed_tag installed_version previous_tag bad_tags notified_tag highest_version; do
    printf '%s=%q\n' "$key" "${!key}"
  done > "$STATE.tmp"
  mv -f "$STATE.tmp" "$STATE"
}

# --- versions ---------------------------------------------------------------------------
# Sortable key: stable X.Y.Z sorts after its own nightlies, nightlies by date and build.
version_key() {
  [[ "${1:-}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-nightly\.([0-9]{8})\.([0-9]+))?$ ]] || return 1
  if [ -n "${BASH_REMATCH[4]}" ]; then
    printf '%06d%06d%06d0%08d%08d\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[5]}" "${BASH_REMATCH[6]}"
  else
    printf '%06d%06d%06d1%08d%08d\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" 0 0
  fi
}
version_lt() { # true when $1 is older than $2; unknown versions never compare older
  local a b
  a="$(version_key "$1")" || return 1
  b="$(version_key "$2")" || return 1
  [[ "$a" < "$b" ]]
}
remember_version() {
  [ -n "${1:-}" ] || return 0
  version_key "$1" > /dev/null || return 0
  if [ -z "$highest_version" ] || version_lt "$highest_version" "$1"; then highest_version="$1"; fi
}
tag_version() { sed -E 's/^mods-v(.+)-[0-9]+$/\1/' <<< "$1"; }

# --- JSON (python3, else jq) ------------------------------------------------------------
json_get() { # json_get <file> <dotted.key>
  if command -v python3 > /dev/null; then
    python3 -c 'import json,sys
v=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."):
    v=v.get(k) if isinstance(v,dict) else None
print("" if v is None else str(v).lower() if isinstance(v,bool) else v)' "$1" "$2" 2> /dev/null
  else
    jq -r ".$2 // empty" "$1" 2> /dev/null
  fi
}

# --- GitHub -----------------------------------------------------------------------------
gh_cmd() {
  command -v gh > /dev/null || die "GitHub CLI (gh) not found; install it and run 'gh auth login'"
  gh "$@"
}

release_files() { # release_files <tag> -> prints the verified download dir
  local tag="$1" dir="$DOWNLOADS/$1" name want have
  if [ ! -f "$dir/mods-manifest.json" ]; then
    mkdir -p "$dir"
    log "downloading $tag"
    gh_cmd release download "$tag" --repo "$REPO" --dir "$dir" --clobber \
      --pattern '*.AppImage' --pattern mods-manifest.json --pattern t3-mods-updater.sh > /dev/null
  fi
  name="$(json_get "$dir/mods-manifest.json" appimage.name)"
  [ -n "$name" ] && [ -f "$dir/$name" ] || { rm -rf "$dir"; die "$tag has no Linux AppImage"; }
  want="$(json_get "$dir/mods-manifest.json" appimage.sha256)"
  have="$(sha256sum "$dir/$name" | cut -d' ' -f1)"
  [ "$want" = "$have" ] || { rm -rf "$dir"; die "AppImage hash mismatch for $tag"; }
  touch "$dir"
  find "$DOWNLOADS" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP_BUILDS + 1)) \
    | cut -d' ' -f2- | while read -r old; do rm -rf "$old"; done
  echo "$dir"
}

# --- processes --------------------------------------------------------------------------
# Every T3 Code process of this user: our AppImage, a vanilla AppImage, or a .deb/rpm
# install (all run the `t3code` executable; AppImage children inherit APPIMAGE).
t3_pids() {
  local proc pid exe appimage
  for proc in /proc/[0-9]*; do
    pid="${proc#/proc/}"
    [ -O "$proc" ] || continue
    exe="$(readlink "$proc/exe" 2> /dev/null || true)"
    appimage="$(tr '\0' '\n' 2> /dev/null < "$proc/environ" | sed -n 's/^APPIMAGE=//p' || true)"
    if [[ "${exe##*/}" == t3code ]] || [[ "${appimage,,}" == *t3* && "$appimage" == *.AppImage ]]; then
      [ "$pid" != "$$" ] && echo "$pid"
    fi
  done
}
cpu_ticks() { # total utime+stime of the given pids and their descendants
  local total=0 pid all
  all="$(ps -e -o pid=,ppid= 2> /dev/null)"
  local -A tree=()
  for pid in "$@"; do tree[$pid]=1; done
  local added=1 child parent
  while [ "$added" -eq 1 ]; do
    added=0
    while read -r child parent; do
      if [ -n "${tree[$parent]:-}" ] && [ -z "${tree[$child]:-}" ]; then tree[$child]=1; added=1; fi
    done <<< "$all"
  done
  for pid in "${!tree[@]}"; do
    [ -r "/proc/$pid/stat" ] || continue
    total=$((total + $(awk '{print $14 + $15}' "/proc/$pid/stat" 2> /dev/null || echo 0)))
  done
  echo "$total"
}
t3_busy() { # agents probably mid-turn: the T3 process tree burned CPU over 20 s
  local before after hz
  hz="$(getconf CLK_TCK)"
  before="$(cpu_ticks "$@")"
  sleep 20
  after="$(cpu_ticks "$@")"
  log "T3 process tree used $(((after - before) * 10 / hz))/10 s CPU in 20 s"
  [ $(((after - before) * 10 / hz)) -gt 20 ]
}
user_idle_minutes() { # -1 when this desktop doesn't say
  local value
  value="$(gdbus call --session --dest org.gnome.Mutter.IdleMonitor --object-path /org/gnome/Mutter/IdleMonitor/Core \
    --method org.gnome.Mutter.IdleMonitor.GetIdletime 2> /dev/null | grep -oE '[0-9]+' | tail -1 || true)"
  [ -n "$value" ] && { echo $((value / 60000)); return; }
  value="$(dbus-send --session --print-reply --dest=org.freedesktop.ScreenSaver /ScreenSaver \
    org.freedesktop.ScreenSaver.GetSessionIdleTime 2> /dev/null | awk '/uint32/ {print $2}' || true)"
  [ -n "$value" ] && { echo $((value / 60)); return; }
  if [ -n "${DISPLAY:-}" ] && command -v xprintidle > /dev/null; then
    value="$(xprintidle 2> /dev/null || true)"
    [ -n "$value" ] && { echo $((value / 60000)); return; }
  fi
  echo -1
}
# The running app's display session, so a relaunch from the timer reaches the desktop.
GUI_ENV=()
capture_gui_env() {
  local pid
  for pid in "$@"; do
    mapfile -t GUI_ENV < <(tr '\0' '\n' 2> /dev/null < "/proc/$pid/environ" \
      | grep -E '^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|XDG_CURRENT_DESKTOP|XDG_SESSION_TYPE|DESKTOP_SESSION)=' || true)
    [ "${#GUI_ENV[@]}" -gt 0 ] && return 0
  done
  return 0
}
stop_t3() {
  local pids
  mapfile -t pids < <(t3_pids)
  [ "${#pids[@]}" -gt 0 ] || return 1
  log "closing T3 Code (${#pids[@]} processes)"
  kill -TERM "${pids[@]}" 2> /dev/null || true
  for _ in $(seq 1 40); do
    [ -z "$(t3_pids)" ] && break
    sleep 0.5
  done
  mapfile -t pids < <(t3_pids)
  [ "${#pids[@]}" -gt 0 ] && kill -KILL "${pids[@]}" 2> /dev/null || true
  sleep 1
  return 0
}
launch_t3() { env "${GUI_ENV[@]}" setsid -f "$APP" > /dev/null 2>&1 < /dev/null; }

# --- install ----------------------------------------------------------------------------
local_environment_enabled() {
  local value
  [ -f "$USERDATA/desktop-settings.json" ] || return 0
  value="$(json_get "$USERDATA/desktop-settings.json" localEnvironmentEnabled)"
  [ "$value" != "false" ]
}
health_check() { # health_check <started-epoch> <was-running>
  local since="$1" was_running="$2" runtime port started pid
  if [ "$was_running" != 1 ]; then
    # Not relaunched (it wasn't open): check the AppImage runtime starts.
    "$APP" --appimage-version > /dev/null 2>&1
    return
  fi
  launch_t3
  if ! local_environment_enabled; then
    # Client only (Settings > Connections > Local environment off): no local server.
    sleep 45
    [ -n "$(t3_pids)" ]
    return
  fi
  runtime="$USERDATA/server-runtime.json"
  for _ in $(seq 1 60); do
    sleep 3
    [ -f "$runtime" ] || continue
    started="$(date -d "$(json_get "$runtime" startedAt)" +%s 2> /dev/null || echo 0)"
    [ "$started" -ge "$since" ] || continue
    pid="$(json_get "$runtime" pid)"
    [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null || continue
    port="$(json_get "$runtime" port)"
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$port/" || echo 000)"
    [ "$code" != 000 ] && [ "$code" -lt 500 ] && return 0
  done
  return 1
}
backup_userdata() { # backup_userdata <label> <with-database 0|1>
  [ -d "$USERDATA" ] || return 0
  local dest sub
  dest="$BACKUPS/$(date +%Y%m%d-%H%M%S)-$1"
  mkdir -p "$dest"
  find "$USERDATA" -maxdepth 1 -type f ! -name 'usage-*' -print0 | while IFS= read -r -d '' file; do
    if [ "$2" = 1 ] || [[ "$file" != *.sqlite* ]]; then cp -p "$file" "$dest/"; fi
  done
  for sub in secrets themes; do [ -d "$USERDATA/$sub" ] && cp -rp "$USERDATA/$sub" "$dest/"; done
  log "backed up userdata to $dest (database: $2)"
  find "$BACKUPS" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +$((KEEP_BACKUPS + 1)) | while read -r old; do rm -rf "$old"; done
}
# The "T3 Code" launcher: the AppImage's own desktop entry pointed at our AppImage. Same
# file name as the .deb's (t3code.desktop), so it also shadows a system-wide install.
desktop_integration() {
  local tmp entry icon
  tmp="$(mktemp -d)"
  (cd "$tmp" && "$APP" --appimage-extract '*.desktop' > /dev/null 2>&1 \
    && "$APP" --appimage-extract 'usr/share/icons/*' > /dev/null 2>&1) || true
  entry="$(find "$tmp/squashfs-root" -maxdepth 1 -name '*.desktop' 2> /dev/null | head -1)"
  icon="$(find "$tmp/squashfs-root/usr/share/icons" -name '*.png' -printf '%s %p\n' 2> /dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
  [ -n "$icon" ] && cp -f "$icon" "$ICON"
  mkdir -p "$(dirname "$DESKTOP_FILE")" "$HOME/.local/bin"
  if [ -n "$entry" ]; then
    # Exec=AppRun %U (or a quoted path) becomes our AppImage, keeping the arguments.
    sed -E -e "s#^Exec=(\"[^\"]*\"|[^ ]+)#Exec=\"$APP\"#" \
      -e "s#^Icon=.*#Icon=$ICON#" -e '/^TryExec=/d' "$entry" > "$DESKTOP_FILE"
  else
    printf '[Desktop Entry]\nName=T3 Code\nExec="%s" %%U\nIcon=%s\nType=Application\nCategories=Development;\nStartupWMClass=t3code\nMimeType=x-scheme-handler/t3code;x-scheme-handler/t3code-dev;\n' "$APP" "$ICON" > "$DESKTOP_FILE"
  fi
  echo "X-T3-Mods=true" >> "$DESKTOP_FILE"
  ln -sf "$APP" "$HOME/.local/bin/t3code"
  command -v update-desktop-database > /dev/null && update-desktop-database "$(dirname "$DESKTOP_FILE")" 2> /dev/null || true
  if command -v xdg-mime > /dev/null; then
    xdg-mime default t3code.desktop x-scheme-handler/t3code 2> /dev/null || true
    xdg-mime default t3code.desktop x-scheme-handler/t3code-dev 2> /dev/null || true
  fi
  rm -rf "$tmp"
}

install_release() { # install_release <tag> <dir>
  local tag="$1" dir="$2" name version build started was_running=0 pids
  name="$(json_get "$dir/mods-manifest.json" appimage.name)"
  version="$(json_get "$dir/mods-manifest.json" version)"
  build="$(json_get "$dir/mods-manifest.json" build)"
  mapfile -t pids < <(t3_pids)
  if [ "${#pids[@]}" -gt 0 ]; then was_running=1; capture_gui_env "${pids[@]}"; fi
  stop_t3 || true
  backup_userdata "before-$tag" "$([ "$installed_version" != "$version" ] && echo 1 || echo 0)"

  log "installing $tag ($version, build $build)"
  started="$(date +%s)"
  cp -f "$dir/$name" "$APP.new"
  chmod +x "$APP.new"
  [ -f "$APP" ] && mv -f "$APP" "$PREVIOUS_APP"
  mv -f "$APP.new" "$APP"
  desktop_integration

  if health_check "$started" "$was_running"; then
    previous_tag="$installed_tag"
    installed_tag="$tag"
    installed_version="$version"
    enabled=1
    remember_version "$version"
    save_state
    log "installed $tag"
    # Each release carries the updater that matches it; used from the next run.
    [ -f "$dir/t3-mods-updater.sh" ] && install -m 0755 "$dir/t3-mods-updater.sh" "$SELF"
    notify "T3 Code updated" "T3 Code $version with mods (build $build)."
    return 0
  fi

  log "health check failed for $tag"
  bad_tags="$bad_tags $tag"
  save_state
  if [ -f "$PREVIOUS_APP" ]; then
    stop_t3 || true
    mv -f "$PREVIOUS_APP" "$APP"
    desktop_integration
    [ "$was_running" = 1 ] && launch_t3
    log "rolled back to ${installed_tag:-the previous build}"
    notify "T3 mods update rolled back" "$tag failed its health check; restored ${installed_tag:-the previous build}."
    return 1
  fi
  notify "T3 mods update failed" "$tag failed its health check. See $LOG."
  die "install of $tag failed and no rollback was possible"
}

# --- vanilla installs -------------------------------------------------------------------
# The newest vanilla T3 Code this user has: AppImages (version from the file name
# T3-Code-<version>-<arch>.AppImage or the embedded X-AppImage-Version) and .deb/rpm
# packages. Feeds the never-downgrade check; `install` also moves user-level vanilla
# AppImages and their launchers aside so only the modded build is launched.
vanilla_appimages() {
  {
    local pid
    for pid in $(t3_pids); do
      tr '\0' '\n' 2> /dev/null < "/proc/$pid/environ" | sed -n 's/^APPIMAGE=//p'
    done
    find "$HOME" "$HOME/Applications" "$HOME/Downloads" "$HOME/Desktop" "$HOME/AppImages" "$HOME/.local/bin" \
      "$HOME/Apps" "$HOME/bin" -maxdepth 1 -iname '*t3*.AppImage' 2> /dev/null
    grep -lis 't3' "$DATA_HOME"/applications/*.desktop 2> /dev/null | xargs -r sed -n 's/^Exec="\{0,1\}\([^" ]*\.AppImage\).*/\1/p'
  } | sort -u | while read -r file; do
    [ -f "$file" ] && [ "$(readlink -f "$file")" != "$(readlink -f "$APP")" ] && [[ "$file" != "$ROOT"/* ]] && echo "$file"
  done
}
appimage_version() {
  local file="$1" version tmp
  version="$(basename "$file" | sed -nE 's/^T3-Code-(.+)-(x86_64|x64|arm64|aarch64)\.AppImage$/\1/p')"
  if [ -z "$version" ] && [ -x "$file" ]; then
    tmp="$(mktemp -d)"
    (cd "$tmp" && timeout 60 "$file" --appimage-extract '*.desktop' > /dev/null 2>&1) || true
    version="$(sed -n 's/^X-AppImage-Version=//p' "$tmp"/squashfs-root/*.desktop 2> /dev/null | head -1)"
    rm -rf "$tmp"
  fi
  echo "$version"
}
system_package() { # name and version of a system-wide T3 Code package, if any
  local owner
  if command -v dpkg-query > /dev/null && owner="$(dpkg-query -S /usr/share/applications/t3code.desktop 2> /dev/null)"; then
    owner="${owner%%:*}"
    echo "$owner $(dpkg-query -W -f='${Version}' "$owner" 2> /dev/null | sed 's/~/-/g')"
  elif command -v rpm > /dev/null && owner="$(rpm -qf --qf '%{NAME} %{VERSION}\n' /usr/share/applications/t3code.desktop 2> /dev/null)"; then
    echo "$owner"
  fi
}
scan_vanilla() {
  local file version package
  while read -r file; do
    version="$(appimage_version "$file")"
    log "vanilla AppImage: $file (${version:-version unknown})"
    remember_version "$version"
  done < <(vanilla_appimages)
  package="$(system_package)"
  if [ -n "$package" ]; then
    log "system package: $package"
    remember_version "${package#* }"
  fi
  save_state
}
retire_vanilla() {
  local file entry
  mkdir -p "$VANILLA"
  while read -r file; do
    log "moving vanilla AppImage aside: $file -> $VANILLA/"
    mv -f "$file" "$VANILLA/"
  done < <(vanilla_appimages)
  for entry in "$DATA_HOME"/applications/*.desktop; do
    [ -f "$entry" ] && [ "$entry" != "$DESKTOP_FILE" ] || continue
    if grep -qiE '^Exec=.*t3[^/]*\.AppImage' "$entry" || grep -qiE '^Name=T3 Code' "$entry"; then
      log "moving vanilla launcher aside: $entry -> $VANILLA/"
      mv -f "$entry" "$VANILLA/"
    fi
  done
  if [ -n "$(system_package)" ]; then
    log "a system-wide T3 Code is installed ($(system_package)); the T3 Code launcher now opens the modded build. Remove the package with your package manager if you no longer want it."
  fi
}

# --- scheduling -------------------------------------------------------------------------
install_timer() {
  if systemctl --user show-environment > /dev/null 2>&1; then
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/t3-mods-updater.service" << EOF
[Unit]
Description=T3 Mods Updater (installs T3-Mods builds of T3 Code when idle)

[Service]
Type=oneshot
ExecStart=$SELF check
EOF
    cat > "$UNIT_DIR/t3-mods-updater.timer" << EOF
[Unit]
Description=Check for T3-Mods builds every 30 minutes

[Timer]
OnStartupSec=5min
OnCalendar=*:0/30
RandomizedDelaySec=2min
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now t3-mods-updater.timer > /dev/null
    log "installed the t3-mods-updater systemd user timer (every 30 min and 5 min after login)"
  elif command -v crontab > /dev/null; then
    (crontab -l 2> /dev/null | grep -v 't3-mods-updater'; echo "*/30 * * * * $SELF check > /dev/null 2>&1") | crontab -
    log "installed a crontab entry (every 30 min); no systemd user session found"
  else
    log "no systemd user session and no crontab: nothing will run 't3-mods-updater check' automatically"
  fi
}
uninstall_timer() {
  if systemctl --user show-environment > /dev/null 2>&1; then
    systemctl --user disable --now t3-mods-updater.timer > /dev/null 2>&1 || true
    rm -f "$UNIT_DIR/t3-mods-updater.service" "$UNIT_DIR/t3-mods-updater.timer"
    systemctl --user daemon-reload
  fi
  if command -v crontab > /dev/null && crontab -l 2> /dev/null | grep -q 't3-mods-updater'; then
    crontab -l | grep -v 't3-mods-updater' | crontab -
  fi
  return 0
}

# --- main -------------------------------------------------------------------------------
mode="${1:-check}"
case "$mode" in check | now | rollback | status | install | uninstall) ;; *)
  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
  ;;
esac

exec 9> "$ROOT/.lock"
flock -n 9 || { echo "Another updater run is in progress."; exit 0; }

case "$mode" in
  status)
    for key in enabled installed_tag installed_version previous_tag bad_tags highest_version; do
      printf '%-18s %s\n' "$key" "${!key}"
    done
    printf '%-18s %s\n' app "$([ -f "$APP" ] && echo "$APP" || echo 'not installed')"
    printf '%-18s %s\n' "local environment" "$(local_environment_enabled && echo on || echo 'off (client only)')"
    systemctl --user list-timers t3-mods-updater.timer --no-pager 2> /dev/null | sed -n '1,2p' || true
    exit 0
    ;;
  uninstall)
    uninstall_timer
    rm -f "$DESKTOP_FILE" "$HOME/.local/bin/t3code" "$HOME/.local/bin/t3-mods-updater"
    log "removed the timer and the launcher; the app, backups and vanilla copies stay in $ROOT"
    exit 0
    ;;
  install)
    gh_cmd auth status > /dev/null 2>&1 || die "gh is not signed in; run 'gh auth login' first"
    gh_cmd release view --repo "$REPO" --json tagName > /dev/null || die "cannot read releases of $REPO with this gh account"
    [ "$(readlink -f "$0")" != "$(readlink -f "$SELF")" ] && install -m 0755 "$0" "$SELF"
    mkdir -p "$HOME/.local/bin"
    ln -sf "$SELF" "$HOME/.local/bin/t3-mods-updater"
    scan_vanilla
    install_timer
    # Running install is the opt-in: from here the timer installs new builds when idle,
    # including the first one if the newest mods build is still older than this machine.
    enabled=1
    save_state
    mode=now
    ;;
esac

if [ "$mode" = rollback ]; then
  [ -n "$previous_tag" ] || die "no previous build recorded"
  dir="$(release_files "$previous_tag")"
  bad_tags="$bad_tags $installed_tag"
  install_release "$previous_tag" "$dir"
  exit $?
fi

if [ "$mode" = check ] && [ "$enabled" != 1 ]; then
  log "automatic installs are off until 't3-mods-updater.sh install' has run"
  exit 0
fi

latest="$(gh_cmd release view --repo "$REPO" --json tagName --jq .tagName)"
target="$latest"
[[ " $bad_tags " == *" $latest "* ]] && target="$installed_tag"
[ -n "$target" ] || exit 0
if [ "$target" = "$installed_tag" ] && [ -f "$APP" ]; then exit 0; fi
# Never downgrade: a vanilla Nightly can be ahead of the newest mods build, and its
# database may already be migrated past what the older build understands.
if [ -n "$highest_version" ] && version_lt "$(tag_version "$target")" "$highest_version"; then
  log "T3 Code $highest_version has run here, newer than $target; waiting for a newer mods build"
  exit 0
fi
dir="$(release_files "$target")"

if [ "$mode" = check ]; then
  mapfile -t running < <(t3_pids)
  if [ "${#running[@]}" -gt 0 ]; then
    capture_gui_env "${running[@]}"
    for entry in "${GUI_ENV[@]}"; do export "${entry?}"; done
    idle="$(user_idle_minutes)"
    if [ "$idle" -lt "$IDLE_MINUTES" ] || t3_busy "${running[@]}"; then
      log "$target ready; waiting for idle (input idle ${idle} min; -1 = unknown)"
      if [ "$notified_tag" != "$target" ]; then
        notified_tag="$target"
        save_state
        notify "T3 mods update ready" "$target installs once T3 Code is idle, or run: t3-mods-updater now"
      fi
      exit 0
    fi
  fi
fi

first_install=0
[ -z "$installed_tag" ] && first_install=1
install_release "$target" "$dir"
# The first modded install takes over from vanilla copies in this user's folders.
[ "$first_install" = 1 ] && retire_vanilla
exit 0
