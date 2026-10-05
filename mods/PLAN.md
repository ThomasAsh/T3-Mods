# T3-Mods — plan

Personal mods for T3 Code, kept alive across upstream updates by an auto-rebasing,
self-repairing build pipeline.

Status: **confirmed 2026-10-05**. Decisions in section 9.

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
  1. `mod-agents-bottom-panel`
  2. `mod-account-router`
- Rules that keep rebases cheap:
  - Most of each mod's code lives in **new files** (`apps/web/src/mods/…`, `apps/server/src/mods/…`).
  - Upstream files only get thin hook edits.
  - Each mod ships a `mods/<mod>/INTENT.md` (what it must do, where it hooks) and tripwire tests. The repair agent works from the intent, not from guesses.

## 3. Update pipeline (auto-heal)

```
upstream stable tag ─▶ rebase stack ─▶ verify ─▶ (repair ⟲ verify) ─▶ build ─▶ publish ─▶ local updater installs
        ▲ hourly check          daily canary on main ─▶ same, but no publish (early warning)
```

1. **Detect.** A scheduled workflow checks hourly for new upstream stable tags. It also runs a daily canary against `main`.
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
5. **Build** Windows x64 NSIS:
   - Unsigned, with **no update feed**, so the in-app updater is off and vanilla can't overwrite it.
   - Same appId, install dir and data dir as the official app.
   - The version string stays identical to upstream, which keeps provider compatibility ranges and remote/SSH server updates working. The mod build ID is recorded separately and shown in Settings › About.
6. **Publish** a private GitHub Release with the installer, sha512 and mods manifest.
7. **Install** with the local *T3 Mods Updater*, a Windows scheduled task that uses your existing `gh` login. It:
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

## 4. Mod 1: Agents in the bottom panel

- The bottom drawer gets a slim tab strip: **Terminal** | **Agents ●n**, where n is the live count.
  - Terminal tabs and splits work exactly as before.
  - Terminals stay mounted (PTYs alive) while Agents is showing.
- Setting: *Settings › General › Show Agents in bottom panel*, on by default. The right-panel Agents tab stays for as long as upstream keeps it.
- The drawer can open on Agents with **no terminal and no project**. Today, opening the drawer always creates a terminal, and closing the last terminal closes the drawer; both behaviours change for the Agents tab.
- Shortcut `Ctrl+Shift+J` opens or toggles Agents. It's handled in the client, with no contract change, so a vanilla server or remote environment still works.
- The active tab and drawer height persist per thread.
- **v0.0.46 port:** upstream deletes `AgentsPanel`, so the mod keeps its own copy (`mods/agents/AgentsPanel.tsx`). It reads the new orchestrator's subagent roster and lineage, the same data mobile's Agents sheet uses. This gets built on `mods/next` before v0.0.46 ships.
- Mobile isn't affected (it has no bottom panel).

## 5. Mod 2: Account auto-router

**Goal:** your accounts behave like one pooled account. The router's main job is finishing work already started when an account runs dry, and it moves as little context as possible.

### Policy
1. **Pool.**
   - Every enabled, signed-in Claude instance in the environment is in the pool, deduplicated by account email.
   - **New accounts join automatically** when you add them in Settings › Providers.
   - Each account has an "exclude from routing" toggle.
2. **Sticky.**
   - A thread stays on its account, because prompt cache is per account.
   - It never switches mid-turn, and never switches just to rebalance.
3. **Switch only when needed:**
   - The account is blocked, **or**
   - it's projected to block: 5-hour window ≥ 92%, weekly ≥ 97%, or the model's own weekly limit. The projection uses the thread's recent burn rate.
4. **Limit hit mid-turn.** Instead of "resume at reset", the router auto-continues on the best other account ("Continue where you left off."). If every account is exhausted, it falls back to vanilla resume-at-reset on whichever account resets soonest.
5. **Cheapest adequate transfer:**
   - Small context (< ~120k tokens): **full native resume**, which gives exact continuity. This depends on spike S1.
   - Large context: T3's **portable handoff** (≤16k-token summary plus pointers to read the thread).
   - The destination becomes sticky, so there's no ping-pong.
   - Returning to an account the thread already used reuses its native session plus a delta only.
6. **New threads** go to the account with the most usable headroom, since there's no cache to lose yet.
   - Ranking is use-it-or-lose-it: prefer the account whose weekly allowance resets soonest while it still has more than the reserve.
   - Ties are broken by 5-hour headroom.
7. **Subagents and forks** inherit the parent's account. Scheduled tasks and agent-created threads route like new threads.
8. **Same model always.** Opus stays Opus. If the model's own limit is exhausted on every account, the thread pauses; the router never silently downgrades.
9. **Fail-open.** Any router error falls back to vanilla behaviour, using the selection the client sent.

### UX
- The model picker's account chip reads **Auto · EAP**. Picking a specific account **pins** the thread, and the router leaves it alone.
- When the router moves a thread, the timeline shows a one-line note: *"Continued on EAP — HDG hit its 5-hour limit (resets 14:30)."*
- The usage popover gets a pooled meter that sums all accounts.
- *Settings › Providers › Auto-routing*:
  - On/off.
  - Reserve thresholds.
  - Exclude accounts.
  - Transfer mode (Smart / Full / Summary).
  - Log of the last 50 decisions.
- Fresher usage data, only when it's needed: while the router is on, accounts above 80% are probed every 60 s.
- Routing happens **on the server**, so it also applies to threads driven from mobile, web or MCP.

### Where it hooks
All hooks are server-side and run before the orchestrator dispatches, so the orchestrator stays pure:
- Thread intake (new threads and follow-ups).
- Queue dequeue re-planning.
- The usage-limit recovery worker.
- MCP and scheduled-task launches.

The contract change is additive only: an optional `routing: "auto" | "pinned"` field.

### Why it ships on v0.0.46
- v0.0.45 can't move threads between separate account dirs, and the handoff and recovery machinery only exists in the new orchestrator.
- So we build it on `mods/next` now, and it ships automatically with the first stable release that includes the new orchestrator.

## 6. Spikes (answered before building)

- **S1, cross-account native resume.** Can a Claude session created on account A resume on account B once its transcript is copied into B's config dir? The risk is thinking-block signatures bound to the account. If it doesn't work, all transfers use the summary.
- **S2, usage freshness.** Is the probe plus `rate_limit_event` early and accurate enough to switch *before* the hard limit?

## 7. Phases

| Phase | Deliverable | Ships on |
|---|---|---|
| 0. Foundation | Repo and fork hygiene, CI pipeline (rebase, verify, repair, build, publish), local updater with backup and rollback, spikes S1 and S2 | — |
| 1. Agents bottom tab | Mod 1 on v0.0.45. First modded install, which proves the pipeline end to end, including a rollback drill | v0.0.45 |
| 2. Router + Agents port | Mod 2, plus Mod 1 ported to the new orchestrator, both on `mods/next` | first stable with the new orchestrator (v0.0.46) |
| 3. Tuning | Review a week of router decisions; tune thresholds | — |

## 8. Honest limits

- Prompt cache **never** transfers between accounts. Every switch costs one re-read of whatever context is carried. The router keeps that to the minimum number of switches and the smallest adequate context.
- Builds are unsigned. The first install of the modded build is manual and may show a SmartScreen prompt. After that, the updater installs silently.
- A mod that upstream fundamentally redesigns (like the Agents panel deletion) is a port, not a conflict fix. The canary on `mods/next` exists to catch these days before a stable release.

## 9. Decisions (confirmed 2026-10-05)

| Question | Decision |
|---|---|
| Account pool | Pools are **per provider**: HDG + EAP form the Claude pool. Codex stays as it is today (one account, so nothing to route). Any new Claude or Codex instance joins its provider's pool automatically. The router never switches provider or model. `claudeAgent_hdg1` in favourites is stale. |
| Build host | **GitHub Actions** in the private repo. AI repair uses a `CLAUDE_CODE_OAUTH_TOKEN` repo secret (from `claude setup-token`). |
| Router timing | Built on `next` against the new orchestrator; ships with **v0.0.46 stable**. Mod 1 ships on v0.0.45 now. |
| Agents layout | **Tabs**: Terminal \| Agents ●n in the bottom drawer. |
