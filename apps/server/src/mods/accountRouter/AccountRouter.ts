/**
 * Account auto-router (t3-mods: account-router).
 *
 * Wraps the orchestrator, so every producer of thread work (clients, MCP tools,
 * scheduled tasks) passes one placement step, and continues runs that hit a
 * usage limit on another account of the same provider. Placement only rewrites
 * `modelSelection.instanceId`; the orchestrator's own provider switch then
 * carries the context (a summary on first visit, a delta on return). Routing
 * fails open: an error dispatches the command as sent.
 */
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestratorV2, type OrchestratorV2Shape } from "../../orchestration-v2/Orchestrator.ts";
import { queuedRunsInDeliveryOrder } from "../../orchestration-v2/QueuedRunOrder.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import { forkParked } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  chooseFailover,
  chooseForFollowUp,
  chooseForNewThread,
  goalToCarry,
  poolContaining,
  requeueableMessages,
  routingPools,
} from "./accountRouter.logic.ts";

type MessageDispatch = Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>;

/** Threads created but not yet messaged, so their first message follows the create. */
const FRESH_THREAD_LIMIT = 200;
/** Fallback for limit failures the event stream missed, e.g. across a restart. */
const SWEEP_INTERVAL = "1 minute";

const withInstance = <C extends { readonly modelSelection?: ModelSelection | undefined }>(
  command: C,
  selection: ModelSelection,
  instanceId: ProviderInstanceId,
): C => ({ ...command, modelSelection: { ...selection, instanceId } });

const isLimitedThread = (shell: OrchestrationV2ThreadShell) =>
  shell.status === "failed" &&
  shell.lastErrorClass === "usage_limit" &&
  shell.latestRunId !== null &&
  shell.archivedAt === null &&
  shell.settledOverride !== "settled" &&
  shell.pendingRuntimeRequest === null;

const makeRoutedOrchestrator = Effect.gen(function* () {
  const inner = yield* OrchestratorV2;
  // Optional, so harnesses that build the orchestrator without them get it unrouted.
  const providerRegistryOption = yield* Effect.serviceOption(ProviderRegistry);
  const serverSettingsOption = yield* Effect.serviceOption(ServerSettingsService);
  if (Option.isNone(providerRegistryOption) || Option.isNone(serverSettingsOption)) {
    yield* Effect.logInfo("t3mods.account-router.unavailable");
    return inner;
  }
  const providerRegistry = providerRegistryOption.value;
  const serverSettings = serverSettingsOption.value;

  /** Reset times of limit failures per account; a lagging snapshot cannot route back into them. */
  const blockedUntilMs = new Map<string, number>();
  const freshThreads = new Map<ThreadId, ProviderInstanceId>();
  /** Each limited run is continued elsewhere at most once; the event path and sweep take turns. */
  const continuedRuns = new Set<string>();
  const continueLock = yield* Semaphore.make(1);

  const loadRouting = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    if (!settings.accountRoutingEnabled) return null;
    const nowMs = yield* Clock.currentTimeMillis;
    const pools = routingPools({
      providers: yield* providerRegistry.getProviders,
      excludedInstanceIds: settings.accountRoutingExcludedInstanceIds,
      blockedUntilMs,
      nowMs,
    });
    return pools.size === 0 ? null : { pools, nowMs };
  });

  const logMove = (event: string, details: Record<string, unknown>) =>
    Effect.logInfo(`t3mods.account-router.${event}`, details);

  const routeMessage = Effect.fn("AccountRouter.routeMessage")(function* (command: MessageDispatch) {
    const mode = command.dispatchMode.type;
    if (
      command.modelSelection === undefined ||
      command.restartContinuationOfRunId !== undefined ||
      command.usageLimitContinuationOfRunId !== undefined ||
      command.manualContinuationOfRunId !== undefined ||
      command.delegatedCompletion !== undefined ||
      command.notification !== undefined ||
      mode === "steer_active" ||
      mode === "restart_active"
    ) {
      return command;
    }
    const fresh = freshThreads.get(command.threadId);
    freshThreads.delete(command.threadId);
    const routing = yield* loadRouting;
    if (routing === null) return command;
    const requested = command.modelSelection.instanceId;
    const pool = poolContaining(routing.pools, requested);
    if (pool === null) return command;
    if (fresh !== undefined) {
      return pool.some((account) => account.instanceId === fresh)
        ? withInstance(command, command.modelSelection, fresh)
        : command;
    }
    const shell = yield* inner.getThreadShell(command.threadId);
    if (shell === null) return command;
    const target = chooseForFollowUp({
      pool,
      current: pool.some((account) => account.instanceId === shell.providerInstanceId)
        ? shell.providerInstanceId
        : null,
      requested,
      model: command.modelSelection.model,
      nowMs: routing.nowMs,
    });
    if (target === requested) return command;
    yield* logMove("follow-up", { threadId: command.threadId, from: requested, to: target });
    return withInstance(command, command.modelSelection, target);
  });

  const routeCommand = Effect.fn("AccountRouter.routeCommand")(function* (
    command: OrchestrationV2ServerCommand,
  ) {
    switch (command.type) {
      case "message.dispatch":
        return yield* routeMessage(command);
      case "thread.create": {
        // An imported native session lives in its own account's config dir.
        if (command.importedNativeThread !== undefined) return command;
        const routing = yield* loadRouting;
        const requested = command.modelSelection.instanceId;
        const pool = routing && poolContaining(routing.pools, requested);
        if (!routing || !pool) return command;
        const target = chooseForNewThread({
          pool,
          requested,
          model: command.modelSelection.model,
          nowMs: routing.nowMs,
        });
        freshThreads.set(command.threadId, target);
        if (freshThreads.size > FRESH_THREAD_LIMIT) {
          freshThreads.delete(freshThreads.keys().next().value!);
        }
        if (target === requested) return command;
        yield* logMove("new-thread", { threadId: command.threadId, from: requested, to: target });
        return withInstance(command, command.modelSelection, target);
      }
      case "delegated_task.request": {
        // The caller may have chosen the account, so it stays while it has room.
        const routing = yield* loadRouting;
        const requested = command.modelSelection.instanceId;
        const pool = routing && poolContaining(routing.pools, requested);
        if (!routing || !pool) return command;
        const target = chooseForFollowUp({
          pool,
          current: null,
          requested,
          model: command.modelSelection.model,
          nowMs: routing.nowMs,
        });
        if (target === requested) return command;
        yield* logMove("delegated-task", { threadId: command.parentThreadId, from: requested, to: target });
        return withInstance(command, command.modelSelection, target);
      }
      default:
        return command;
    }
  });

  const dispatch: OrchestratorV2Shape["dispatch"] = (command) =>
    routeCommand(command).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("t3mods.account-router.route-failed", { cause }).pipe(Effect.as(command)),
      ),
      Effect.flatMap(inner.dispatch),
    );

  /** Re-queues waiting messages onto the new account, in order, so the queue does not walk back. */
  const requeueOnto = Effect.fn("AccountRouter.requeueOnto")(function* (
    threadId: ThreadId,
    from: ProviderInstanceId,
    to: ProviderInstanceId,
  ) {
    const { runs } = yield* inner.getThreadRecords(threadId, ["runs"]);
    const queued = runs.filter((run) => run.status === "queued");
    if (queued.length === 0) return;
    const { messages } = yield* inner.getThreadRecords(threadId, ["messages"], {
      messageIds: queued.map((run) => run.userMessageId),
    });
    const moves = requeueableMessages({
      queuedRuns: queuedRunsInDeliveryOrder({ runs: queued, messages }),
      messages,
      from,
    });
    for (const { run, message } of moves) {
      yield* inner.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make(`t3mods-requeue-cancel:${run.id}`),
        threadId,
        runId: run.id,
      });
      yield* inner.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`t3mods-requeue:${run.id}`),
        messageId: MessageId.make(`t3mods-requeue:${run.id}`),
        threadId,
        text: message.text,
        attachments: [],
        ...(message.context === undefined ? {} : { context: message.context }),
        ...(message.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
        modelSelection: { ...run.modelSelection, instanceId: to },
        dispatchMode: { type: "queue_after_active" },
        createdBy: message.createdBy,
        creationSource: message.creationSource,
      });
    }
  });

  /** Continues a thread whose latest run hit a usage limit on the best other account. */
  const continueElsewhere = Effect.fn("AccountRouter.continueElsewhere")(function* (
    shell: OrchestrationV2ThreadShell,
  ) {
    const runId = shell.latestRunId;
    if (!isLimitedThread(shell) || runId === null || continuedRuns.has(runId)) return;
    // The run's own account: the thread's may already point elsewhere after a picker change.
    const { runs } = yield* inner.getThreadRecords(shell.id, ["runs"], { runIds: [runId] });
    const run = runs.find((candidate) => candidate.id === runId);
    if (run === undefined) return;
    const from = run.providerInstanceId;
    const resetMs = shell.usageLimitResetAt ? Date.parse(shell.usageLimitResetAt) : Number.NaN;
    if (Number.isFinite(resetMs)) {
      blockedUntilMs.set(from, Math.max(blockedUntilMs.get(from) ?? 0, resetMs));
    }
    const routing = yield* loadRouting;
    const pool = routing && poolContaining(routing.pools, from);
    if (!routing || !pool) return;
    const target = chooseFailover({
      pool,
      from,
      model: run.modelSelection.model,
      nowMs: routing.nowMs,
    });
    // No account has room: upstream's resume-at-reset (if enabled) takes over.
    if (target === null) return;
    const { providerThreads } = yield* inner.getThreadRecords(shell.id, ["providerThreads"]);
    const goal = goalToCarry(
      providerThreads.find((providerThread) => providerThread.id === run.providerThreadId)?.goal,
    );
    continuedRuns.add(runId);
    const fromLabel = pool.find((account) => account.instanceId === from)?.label ?? from;
    const modelSelection = { ...run.modelSelection, instanceId: target.instanceId };
    // The continuation carries the context handoff, so it goes first as a plain message.
    yield* inner.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`t3mods-continue:${runId}`),
      messageId: MessageId.make(`t3mods-continue:${runId}`),
      threadId: shell.id,
      manualContinuationOfRunId: runId,
      text: `Continue where you left off. (Moved from ${fromLabel} to ${target.label}: ${fromLabel} hit its usage limit.)`,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    });
    yield* logMove("continued", { threadId: shell.id, runId, from, to: target.instanceId });
    // A goal command must run as its own turn; queued, it re-arms the goal on the new account.
    if (goal !== null) {
      yield* inner.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`t3mods-goal:${runId}`),
        messageId: MessageId.make(`t3mods-goal:${runId}`),
        threadId: shell.id,
        text: `/goal ${goal}`,
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
      });
    }
    yield* requeueOnto(shell.id, from, target.instanceId);
  });

  const consider = (threadId: ThreadId) =>
    inner.getThreadShell(threadId).pipe(
      Effect.flatMap((shell) => (shell === null ? Effect.void : continueElsewhere(shell))),
      continueLock.withPermits(1),
      Effect.catchCause((cause) =>
        Effect.logWarning("t3mods.account-router.continue-failed", { threadId, cause }),
      ),
    );

  yield* forkParked(
    Stream.runForEach(inner.streamDomainEvents, (event) =>
      event.type === "run.updated" && event.payload.status === "failed"
        ? consider(event.threadId)
        : Effect.void,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("t3mods.account-router.event-stream-failed", { cause }),
      ),
    ),
  );
  yield* forkParked(
    Effect.gen(function* () {
      if ((yield* loadRouting) === null) return;
      const snapshot = yield* inner.getShellSnapshot({ unsettledOnly: true });
      for (const shell of snapshot.threads) {
        if (isLimitedThread(shell)) yield* consider(shell.id);
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("t3mods.account-router.sweep-failed", { cause })),
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
      Effect.asVoid,
    ),
  );

  return { ...inner, dispatch } satisfies OrchestratorV2Shape;
});

/** Provides the orchestrator from `orchestrator`, with account routing in front of `dispatch`. */
export const withAccountRouter = <E, R>(orchestrator: Layer.Layer<OrchestratorV2, E, R>) =>
  Layer.effect(OrchestratorV2, makeRoutedOrchestrator).pipe(Layer.provide(orchestrator));
