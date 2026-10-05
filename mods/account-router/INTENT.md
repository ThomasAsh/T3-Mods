# Mod: account auto-router

## What it must do

The user's provider accounts behave like one pool per provider, so they never have to think about which account has room. The router's main job is finishing work already started when an account runs out; it moves as little context as possible.

- **Pools.** Every enabled, signed-in instance of a provider driver is in that driver's pool. Instances that share a config dir (same continuation group key) count as one account. A new instance joins its pool as soon as it is usable. Drivers with one account are left alone (today Codex). The router never changes provider or model.
- **Sticky.** A thread stays on its account while that account has room, because prompt cache lives per account. The router never moves a thread just to rebalance.
- **Failover.** When a thread's latest run fails with a `usage_limit` failure, the router continues it on the best other account in its pool. It uses a manual continuation (`manualContinuationOfRunId`) with the new account in `modelSelection`, so upstream's own provider switch carries the context: a summary of at most 16k tokens the first time the thread visits an account, and a delta when it returns. The message reads "Continue where you left off. (Moved from HDG to EAP: HDG hit its usage limit.)". The thread's waiting plain-text queued messages are re-queued onto the new account in order; messages with attachments or from automations stay as they are. If no other account has room, nothing happens and upstream's resume-at-reset applies. If the run's provider thread had a native `/goal` still being worked on (status `active` or `usage_limited`), the router queues `/goal <objective>` on the new account right after the continuation, because a goal lives in the account's own session and a goal command must run as its own turn (the continuation, not the goal command, carries the context handoff). The old account's session keeps its copy, which only matters if the thread returns there.
- **Follow-ups.** Before a message starts a turn, an account at or above 90% of its session window, or 97% of a weekly window (including a model-scoped weekly), counts as nearly full. The thread moves to a healthy account if there is one, otherwise it stays. An account the user picked in the composer is honoured while it has room.
- **New threads** start on the best account: healthy first, then weekly allowance that resets within 24 hours (use it or lose it), then the most session room.
- **Delegated tasks** keep the requested account while it has room, since the caller may have picked it.
- **Imported native sessions, forks, steering and restarts** are never rerouted.
- **Fail open.** Any routing error dispatches the command as sent.
- *Settings › General › Route between accounts* turns it on or off (on by default) and lists the pooled accounts with a switch each (`accountRoutingEnabled`, `accountRoutingExcludedInstanceIds` in server settings).

## Where it hooks in (`git grep t3-mods: -- apps packages`)

| Upstream file | Hook |
|---|---|
| `apps/server/src/orchestration-v2/runtimeLayer.ts` | `layerOrchestratorProvided` is `withAccountRouter(Orchestrator.layer)`, so every `OrchestratorV2.dispatch` (WS, MCP, scheduled tasks, launches) passes the router. |
| `packages/contracts/src/settings.ts` | `accountRoutingEnabled` and `accountRoutingExcludedInstanceIds` in `ServerSettings` and `ServerSettingsPatch`. |
| `apps/web/src/components/settings/SettingsPanels.tsx` | `<AccountRoutingSettingsRow providers={serverProviders} />` after "Snooze limited threads". |
| `apps/web/src/components/settings/settingsSearch.ts` | Search item `account-routing`. |

Server code: `apps/server/src/mods/accountRouter/`. `accountRouter.logic.ts` holds every decision as pure functions, covered by `accountRouter.logic.test.ts`. `AccountRouter.ts` applies them. It wraps `dispatch` (rewriting `modelSelection.instanceId` on `thread.create`, `message.dispatch` and `delegated_task.request`), reacts to `run.updated` failures on `streamDomainEvents`, and sweeps the shell snapshot every minute for limited threads it missed. Web code: `apps/web/src/mods/accountRouter/`.

Inputs it relies on: `ProviderRegistry.getProviders` (per-instance `usageLimits.windows`, `continuation.groupKey`, `auth`, `models`) and the thread shell (`status`, `lastErrorClass`, `usageLimitResetAt`, `latestRunId`, `providerInstanceId`, `modelSelection`).

## Upstream changes to watch

- If upstream changes what `manualContinuationOfRunId` accepts (today: the latest executed run, `interrupted` or `failed` with class `usage_limit`, `start_immediately`), keep the failover on whatever continuation path accepts another instance.
- If upstream starts carrying native goals across a provider switch, drop the goal re-issue (`goalToCarry`).
- If upstream adds its own cross-account failover or routing, switch this mod off in `mods.json` and drop it rather than running two routers.
- If the provider switch stops being lazy (applied on the next message), placement must still happen before dispatch.
