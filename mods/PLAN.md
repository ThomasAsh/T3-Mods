# T3-Mods — plan

Personal mods for T3 Code, kept alive across upstream updates by an auto-rebasing,
self-repairing build pipeline.

Status: **confirmed 2026-10-05, updated 2026-10-07**. Decisions in section 9.

---

## 1. What the investigation found

| Fact | Why it matters |
|---|---|
| Installed: **v0.0.45 stable** (`6c8fed35d`), per-user NSIS install at `%LOCALAPPDATA%\Programs\t3code`; in-app updater polls `pingdotgg/t3code`. | Our build must replace this install and stop vanilla from overwriting it. |
| Upstream is MIT and fast-moving: stable every few days, nightlies several times a day. 169 commits since v0.0.45. | Mods must be cheap to re-apply; breakage has to be detected and fixed automatically. |
| Upstream `main` has the **new orchestrator** (#2829, 2 Oct), which no stable release includes yet. It removes the Agents tab, adds cross-account handoff and usage-limit recovery, and migrates data one way (`statev2.sqlite`, `%APPDATA%\t3code-v2`). | v0.0.46 will be a big jump. The router should be built on the new orchestrator, and user data must be backed up before crossing it. |
| The Agents tab (v0.0.45) is `AgentsPanel`, a right-panel "fleet view" of subagents and workflows with live status, activity and tokens. **It is deleted on `main`.** | Vanilla v0.0.46 loses the Agents tab. Our mod has to own the view from then on. |
| The bottom drawer is per-thread state (`terminalUiStateStore`) and supports multiple terminals and splits but has no tab strip. It renders only when the thread has a project/cwd. | We add a tab strip and let the drawer open with no terminal or project. |
| The existing **Load balancing** setting spreads **new threads across machines** by CPU and RAM. Its keys are environment IDs. It ignores usage. | It isn't an account router. The router is new work, though its draft-time "auto pick" UX is a useful pattern. |
| Usage is per account and near-live: a `get_usage` probe (about every 5 min) gives 5-hour, weekly and model-scoped weekly windows, plus `rate_limit_event`s streamed during turns. | The router has the inputs it needs and only needs fresher probes near the limits. |
| v0.0.45 only lets a thread switch between instances that share a config dir. HDG (`~/.claude`) and EAP (`~/.claude_b`) are separate, so threads can't move between them today. | Mid-thread rerouting needs the new orchestrator, or a transcript transplant (see spike S1). |
| v0.0.46 handoff: the first move to an account carries a ≤16k-token summary plus thread-read pointers. Moving back to an account the thread already used resumes its native session plus a delta. | This is the cheap transfer path. Full native resume across accounts is the exact path, if S1 passes. |
| The in-app updater accepts a fork feed, but **only from a public GitHub repo** (no token support). | With a private repo, we bring our own updater and disable the in-app one. |
| A fork build with the same appId installs over the official one and shares `~/.t3/userdata`. | All threads, settings and logins carry over, so no migration is needed. |

## 2. Repository: private `ThomasAsh/T3-Mods`

The repo holds the full t3code history plus our branches:

- `upstream/main`: fast-forward mirror of `pingdotgg/t3code` main. We never commit to it.
- `mods/stable`: the latest upstream **stable tag** plus the mod stack. This is what gets installed.
- `mods/next`: upstream `main` plus the mod stack, as a canary. Ports get done here before the next stable ships.
- The mod stack is an ordered series of commits, one per mod:
  0. `fork-hygiene`: remove upstream release, deploy and mobile workflows; add ours. Build config: no upstream update feed, keep T3 Connect public IDs.
  1. `mod-account-router`
- Rules that keep rebases cheap:
  - Most of each mod's code lives in **new files** (`apps/web/src/mods/…`, `apps/server/src/mods/…`).
  - Upstream files only get thin hook edits.
  - Each mod ships a `mods/<mod>/INTENT.md` (what it must do, where it hooks) and tripwire tests. The repair agent works from the intent, not from guesses.

## 3. Update pipeline (auto-heal)

```
upstream stable tag ─▶ rebase stack ─▶ verify ─▶ (repair ⟲ verify) ─▶ build ─▶ publish ─▶ local updater installs
        ▲ hourly check          daily canary on main ─▶ same, but no publish (early warning)
```

1. **Detect.** A scheduled workflow watches the followed channel: hourly for stable tags, daily for nightlies. While following stable, it also runs a daily canary against upstream `main`.
2. **Rebase** the stack onto the tag, with `git rerere` on so resolved conflicts stay resolved.
3. **Verify:**
   - Install and run a targeted typecheck (contracts, server, web).
   - Run the mods' tripwire tests.
   - Run upstream tests for every upstream file the mods touch.
   - Run the desktop smoke build.
4. **Repair** when step 2 or 3 fails:
   - Claude Code runs headless in the worktree with a scoped prompt: `INTENT.md`, the failing output, and the upstream diff.
   - It gets up to 3 attempts, re-verifying after each.
   - Work goes on a `repair/<tag>` branch with a PR, auto-merged when green.
5. **Build** three artifacts from one JS bundle:
   - Windows x64 NSIS installer and Linux x64 AppImage: unsigned, with **no update feed**, so the in-app updater is off and vanilla can't overwrite them. Same appId, install dir and data dir as the official app.
   - Linux x64 CLI archive: the headless server the HD/HDG containers run. Server-side mods (the router) only act where the server runs them, so the servers need this build; a tripwire fails the build if the router is missing from it.
   - The version string stays identical to upstream, which keeps provider compatibility ranges and remote/SSH server updates working. The mod build ID is recorded separately and shown in Settings › About.
6. **Publish** a private GitHub Release with all three, the mods manifest (SHA-256 of each) and both updater scripts.
7. **Install.** The servers' `t3-auto-update.sh` installs the CLI archive into the image (hourly check, idle-aware, rollback). Desktops use the local *T3 Mods Updater*: a Windows scheduled task (`T3ModsUpdater.ps1`) or a Linux systemd user timer (`t3-mods-updater.sh`), both using your existing `gh` login. It:
   - Downloads the release and verifies the hash.
   - **Backs up userdata** (settings, keybindings, DB snapshot) before any upstream version bump. This matters for the one-way v0.0.46 migration.
   - Waits until no turns are running, then installs silently and relaunches.
   - Health-checks the server, and **rolls back automatically** to the previous installer if the check fails.
   - Keeps the last 3 builds.
8. **Notify.** Failures send a Windows toast and open a GitHub issue. If repair can't fix a release, you stay on the last good modded build and nothing breaks.

Safety rails:
- Every mod has a runtime kill switch in Settings.
- The router fails open to vanilla behaviour.
- The pipeline never writes to `~/.t3/userdata` itself.
- If something reinstalls vanilla (e.g. `winget upgrade --all`), the updater notices the missing mods marker and reinstalls the modded build. Recommend `winget pin add T3Tools.T3Code`.

## 4. Mod 1: Agents in the bottom panel (dropped 2026-10-07)

Shipped from v0.0.45 to the 2735 nightly, then dropped: upstream nightly's own additions made it redundant. Its commit is gone from the stack; tag `mods-v0.0.46-nightly.20261006.2735-9` still has it.

## 5. Mod 2: Account auto-router

**Goal:** your accounts behave like one pooled account per provider. The router's main job is finishing work already started when an account runs dry, and it moves as little context as possible. Spec: [`account-router/INTENT.md`](account-router/INTENT.md).

### Policy
1. **Pool.** Every enabled, signed-in instance of a provider, deduplicated by config dir. New accounts join automatically; each can be switched off in Settings. Single-account providers (Codex today) are left alone.
2. **Sticky.** A thread stays on its account while it has room, because prompt cache is per account. Never moved just to rebalance.
3. **Failover (the main job).** When a run fails on a usage limit, the router immediately continues it on the best other account ("Continue where you left off. (Moved from HDG to EAP: HDG hit its usage limit.)"). Queued plain-text follow-ups move with it. If no account has room, upstream's resume-at-reset applies.
4. **Before a turn starts**, an account at ≥ 90% of its 5-hour window or ≥ 97% of a weekly window (including the model's own weekly) counts as nearly full; the thread moves to a healthy account if there is one.
5. **Cheapest transfer.** The router only changes the thread's account; upstream's provider switch carries the context: a summary of ≤ 16k tokens plus thread-read pointers on the first visit to an account, and a native resume plus delta when returning to one. The destination is sticky, and the account it left counts as blocked until its reset, so there's no ping-pong.
6. **New threads** start on the account with the most usable room: healthy first, then weekly allowance that resets within 24 h, then the most 5-hour room.
7. **Same model always.** Never changes provider or model.
8. **Fail-open.** Any router error dispatches the command as sent.

### Where it hooks
- One wrapper on `OrchestratorV2.dispatch` (in `runtimeLayer.ts`), so clients, MCP tools, scheduled tasks and launches all pass it.
- A reactor on the orchestrator's domain events for limit failures, plus a one-minute sweep as a fallback.
- Two flat server settings: `accountRoutingEnabled`, `accountRoutingExcludedInstanceIds`.

### Left out on purpose
- **Native cross-account resume** (copying a transcript between config dirs, spike S1). Upstream's handoff already moves at most a 16k summary, which is cheaper than re-reading a full transcript uncached, and it needs no adapter changes.
- **Per-thread pins, an "Auto" chip and a decision-log UI.** An account picked in the composer is honoured while it has room, which covers pinning in practice. Decisions are logged on the server (`t3mods.account-router.*`).

## 6. Spikes

- **S1, cross-account native resume:** not needed (see above).
- **S2, usage freshness:** in-turn `rate_limit_event`s keep the active account current; idle accounts refresh with the regular probe (every 5 min). A limit hit mid-turn is handled by failover anyway.

## 7. Phases

| Phase | Deliverable | Ships on |
|---|---|---|
| 0. Foundation | Repo, CI pipeline (rebase, verify, repair, build, publish), local updater with backup and rollback | done |
| 1. Agents bottom tab | Mod 1 | v0.0.45 to the 2735 nightly; dropped 2026-10-07 |
| 2. Router | Mod 2 | nightly builds now (channel decision below) |
| 3. Tuning | Review a week of router decisions in the server log; tune thresholds | — |

## 8. Honest limits

- Prompt cache **never** transfers between accounts. Every switch costs one re-read of whatever context is carried. The router keeps that to the minimum number of switches and the smallest adequate context.
- Builds are unsigned. The first install of the modded build is manual and may show a SmartScreen prompt. After that, the updater installs silently.
- A mod that upstream fundamentally redesigns (like the Agents panel deletion) is a port, not a conflict fix. The canary on `mods/next` exists to catch these days before a stable release.

## 9. Decisions (confirmed 2026-10-05)

| Question | Decision |
|---|---|
| Account pool | Pools are **per provider**: HDG + EAP form the Claude pool. Codex stays as it is today (one account, so nothing to route). Any new Claude or Codex instance joins its provider's pool automatically. The router never switches provider or model. `claudeAgent_hdg1` in favourites is stale. |
| Build host | **GitHub Actions** in the private repo. AI repair uses a `CLAUDE_CODE_OAUTH_TOKEN` repo secret (from `claude setup-token`). |
| Router timing | Built on `next` against the new orchestrator; shipped on the nightlies. |
| Channel (2026-10-06) | The installed app moved to the Nightly channel, whose data migration can't be undone. Builds follow **upstream nightlies** (one build a day) until v0.0.46 stable ships, then follow stable releases automatically (`mods.json` `upstream`). |
| Where mods run (2026-10-07) | The router acts in the server that owns a thread, so **HD and HDG run the modded server** (Linux CLI archive) instead of npm `t3`; until then it routed nothing on them. **Desktop clients stay modded** (PC on Windows, laptop on Linux) for the router's switch in Settings. The Agents tab mod is dropped. |
