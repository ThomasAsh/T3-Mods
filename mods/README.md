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
| `mods-sync` (release) | Hourly for stable, daily for nightly | Detects a new upstream tag on the followed channel, rebases `main`, verifies, repairs with Claude Code if needed, then builds and publishes |
| `mods-sync` (canary) | Daily, while following stable | Same against upstream `main`, pushed to `next`; never publishes |
| `mods-verify` | Push to `main`, `next`, `mod/**`, `repair/**` | Typecheck, tests and lint for what the stack touches |
| `mods-build` | On demand or from sync | Windows x64 installer, published as a private release |

The channel is set in [`mods.json`](mods.json) under `upstream`. With `"channel": "nightly"` and `"stableFrom": "0.0.46"`, the stack follows nightlies until v0.0.46 stable is out, then switches to stable releases by itself.

`next` is derived from `main`. The tag `mods-next-source` records which `main` commit it was built from. A stable sync reuses `next` (and the ports already done there) only while `main` is unchanged and `next`'s upstream base is part of the new release. Otherwise it rebases `main`.

Develop mods on `mod/<name>` branches. Once verify is green, rebase onto `main` and fast-forward.

## Local updater

Install it once per machine:

```powershell
powershell -ExecutionPolicy Bypass -File mods\updater\Install-T3ModsUpdater.ps1
& "$env:LOCALAPPDATA\T3ModsUpdater\T3ModsUpdater.ps1" -Mode now   # first install; closes T3 Code
```

After that, the scheduled task installs new releases whenever T3 Code is idle. Other modes:

- `-Mode status` shows the current state.
- `-Mode rollback` restores the previous build.

Logs are in `%LOCALAPPDATA%\T3ModsUpdater\updater.log`.

Modded installers ship with **no update feed**, so the in-app updater is off and a vanilla build can't replace them. The local updater ([`updater/`](updater)) installs releases instead. Before installing it:

- verifies the release hash
- backs up userdata
- waits for idle

After installing, it health-checks the app and rolls back if the check fails.

## Secrets

| Secret | Used by |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Repair step. Create it with `claude setup-token`. |

`GITHUB_TOKEN` covers everything else.
