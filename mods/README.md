# T3-Mods

Personal mods for [T3 Code](https://github.com/pingdotgg/t3code). An automated pipeline keeps them on top of each upstream release.

Design and decisions: [PLAN.md](PLAN.md).

## Branches

| Branch | Contents |
|---|---|
| `main` | Latest upstream release on the followed channel, plus the mod stack. This is what gets built and installed. The pipeline rebases it, so history is rewritten. |
| `next` | Upstream `main` plus the mod stack. A canary: breakage and ports show up here before the next stable release. |
| `repair/*` | Automated repair attempts, merged once they pass verification. |

Every published build is tagged `mods-v<version>-<build>`, so earlier states stay reachable after a rebase.

## The mod stack

Each mod is one commit on top of the upstream tag, kept in the order of [`mods.json`](mods.json). The rules that keep rebases cheap:

- Put a mod's code in **new files**: `apps/*/src/mods/<mod>/…`.
- Touch upstream files only with thin hooks. Every hook line carries a `t3-mods:` comment, so `git grep t3-mods:` finds them all.
- Give each mod an `INTENT.md` in `mods/<mod>/`, stating what it must do and where it hooks in. The repair agent works from this file.
- Each mod's tests sit next to its code and act as tripwires when upstream changes underneath.

## Pipeline

| Workflow | When | What |
|---|---|---|
| `mods-sync` (release) | Hourly for stable, daily at 06:30 AEST for nightly | Detects a new upstream tag on the followed channel, rebases `main`, verifies, repairs with Claude Code if needed, then builds and publishes |
| `mods-sync` (canary) | Daily, while following stable | Same against upstream `main`, pushed to `next`; never publishes |
| `mods-verify` | Push to `main`, `next`, `mod/**`, `repair/**` | Typecheck, tests and lint for what the stack touches |
| `mods-build` | On demand or from sync | Windows x64 installer, Linux x64 AppImage and Linux x64 server (CLI archive), published as one private release |

The channel is set in [`mods.json`](mods.json) under `upstream`. With `"channel": "nightly"` and `"stableFrom": "0.0.46"`, the stack follows nightlies until v0.0.46 stable is out, then switches to stable releases by itself.

`next` is derived from `main`. The tag `mods-next-source` records which `main` commit it was built from. A stable sync reuses `next` (and the ports already done there) only while `main` is unchanged and `next`'s upstream base is part of the new release. Otherwise it rebases `main`.

Develop mods on `mod/<name>` branches. Once verify is green, rebase onto `main` and fast-forward.

## Where the builds run

| Machine | Build | Installed by |
|---|---|---|
| HD and HDG (headless servers) | Linux x64 server, `t3-<version>-linux-x64.tar.gz` | `t3-auto-update.sh` on each Unraid host (horizon-fleet-manager `t3code/build`) |
| Windows desktops | `T3-Code-<version>-x64.exe` | `T3ModsUpdater.ps1` (below) |
| Linux desktops | `T3-Code-<version>-x86_64.AppImage` | `t3-mods-updater.sh` (below) |

Server-side mods (the account router) act on every thread of the server that runs them, so they need the modded **server**; the desktop builds add the client side (the router's switch in Settings).

**Servers first.** A client ahead of its servers gets "server out of date" on every environment. The servers check every 5 minutes and, once a server runs a release, it uploads `deployed-<HD|HDG>.txt` to that release. The desktop updaters install a release only when every server has (after 12 hours they install anyway), so a new build reaches the servers within minutes and the desktops right after.

## Local updater

Install it once per machine.

**Windows:**

```powershell
gh release download --repo ThomasAsh/T3-Mods --pattern T3ModsUpdater.ps1 --dir $env:TEMP\t3-mods --clobber
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\t3-mods\T3ModsUpdater.ps1 -Mode install
```

This registers "T3 Mods Updater" (every 10 minutes) and "T3 Mods Updater (wake)" (logon, unlock, resume from sleep) and installs the latest build (closing T3 Code if needed). In the 15 minutes after a wake an update only waits for local agents, not for you to be idle, so it lands before the day's work. Other modes:

- `-Mode status` shows the current state.
- `-Mode rollback` restores the previous build.
- `-Mode uninstall` removes the tasks.

Logs are in `%LOCALAPPDATA%\T3ModsUpdater\updater.log`.

**Linux** (needs `gh` signed in; installs a systemd user timer that runs every 10 minutes and on wake, the "T3 Code" launcher and the latest build, and moves vanilla T3 Code AppImages in your home folders to `~/.local/share/t3-mods/vanilla`):

```bash
gh release download --repo ThomasAsh/T3-Mods --pattern t3-mods-updater.sh --dir /tmp/t3-mods --clobber
bash /tmp/t3-mods/t3-mods-updater.sh install
```

Then `t3-mods-updater status|now|rollback|uninstall`; log in `~/.local/share/t3-mods/updater.log`.

Modded desktop builds ship with **no update feed**, so the in-app updater is off and a vanilla build can't replace them. The local updaters ([`updater/`](updater)) install releases instead. Before installing, they:

- take the updater that ships with the new release (and its schedule)
- wait for the servers (above)
- verify the release hash
- never install a build older than the newest T3 Code that machine has run
- back up userdata
- wait for idle

After installing, they health-check the app and roll back if the check fails. With *Settings › Connections › Local environment* off (a client-only machine), the check is that the app stays up, since no local server starts.

## Secrets

| Secret | Used by |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Repair step. Create it with `claude setup-token`. |

`GITHUB_TOKEN` covers everything else.
