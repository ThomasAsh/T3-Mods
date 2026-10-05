import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import type {
  ProjectionRecordField,
  ProjectionRecords,
} from "../../orchestration-v2/ProjectionStore.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { withAccountRouter } from "./AccountRouter.ts";

const OPUS = "claude-opus-5-5";
const HDG = ProviderInstanceId.make("claudeAgent");
const EAP = ProviderInstanceId.make("claudeAgent_eap");
const CREATED_AT = DateTime.makeUnsafe("2026-10-06T00:00:00.000Z");
const RESETS_AT = "2026-10-06T02:50:00.000Z";

const provider = (instanceId: ProviderInstanceId, sessionUsed: number): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: instanceId === HDG ? "HDG" : "EAP",
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-06T00:00:00.000Z",
  models: [{ slug: OPUS, name: "Opus", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  continuation: { groupKey: `claude:home:${instanceId}` },
  usageLimits: {
    checkedAt: "2026-10-06T00:00:00.000Z",
    windows: [
      { id: "five_hour", kind: "session", label: "Session", usedPercent: sessionUsed, resetsAt: RESETS_AT },
    ],
  },
});

const shell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  createdBy: "user",
  creationSource: "web",
  id: ThreadId.make(id),
  projectId: ProjectId.make("project"),
  title: "Thread",
  providerInstanceId: HDG,
  modelSelection: { instanceId: HDG, model: OPUS },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: RunId.make(`${id}-run`),
  activeRunId: null,
  status: "completed",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [HDG],
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  ...overrides,
});

const failedRun = (threadId: string, instanceId: ProviderInstanceId): OrchestrationV2Run => ({
  id: RunId.make(`${threadId}-run`),
  threadId: ThreadId.make(threadId),
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: OPUS },
  providerThreadId: ProviderThreadId.make(`${threadId}-provider-thread`),
  userMessageId: MessageId.make(`${threadId}-message`),
  rootNodeId: null,
  activeAttemptId: null,
  status: "failed",
  requestedAt: CREATED_AT,
  startedAt: CREATED_AT,
  completedAt: CREATED_AT,
  checkpointId: null,
  contextHandoffId: null,
});

const limitedShell = (id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  shell(id, {
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: RESETS_AT,
    ...overrides,
  });

const message = (threadId: string, instanceId: ProviderInstanceId): OrchestrationV2ServerCommand => ({
  type: "message.dispatch",
  createdBy: "user",
  creationSource: "web",
  commandId: CommandId.make(`message:${threadId}`),
  messageId: MessageId.make(`message:${threadId}`),
  threadId: ThreadId.make(threadId),
  text: "Next step",
  attachments: [],
  modelSelection: { instanceId, model: OPUS },
  dispatchMode: { type: "start_immediately" },
});

/**
 * The router in front of a recording orchestrator. `continued` resolves with the
 * first manual continuation the router dispatches.
 */
const makeRouter = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly shells?: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly runs?: ReadonlyArray<OrchestrationV2Run>;
  readonly providerThreads?: ReadonlyArray<{
    readonly id: string;
    readonly goal: { readonly objective: string; readonly status: string } | null;
  }>;
  readonly routingEnabled?: boolean;
}) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const continued = yield* Deferred.make<OrchestrationV2ServerCommand>();
    const goalQueued = yield* Deferred.make<OrchestrationV2ServerCommand>();
    const shells = input.shells ?? [];
    const runs = input.runs ?? [];
    const orchestrator = Layer.mock(OrchestratorV2)({
      dispatch: (command) =>
        Effect.gen(function* () {
          dispatched.push(command);
          if (command.type === "message.dispatch" && command.manualContinuationOfRunId) {
            yield* Deferred.succeed(continued, command);
          }
          if (command.type === "message.dispatch" && command.text.startsWith("/goal ")) {
            yield* Deferred.succeed(goalQueued, command);
          }
          return { sequence: dispatched.length, storedEvents: [] };
        }),
      getThreadShell: (threadId) =>
        Effect.succeed(shells.find((candidate) => candidate.id === threadId) ?? null),
      getShellSnapshot: () =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: shells,
          archivedThreads: [],
        }),
      // Only the records the router reads: runs, provider threads, and no queued messages.
      getThreadRecords: <K extends ProjectionRecordField>(threadId: ThreadId) =>
        Effect.succeed({
          runs: runs.filter((run) => run.threadId === threadId),
          providerThreads: input.providerThreads ?? [],
          messages: [],
        } as unknown as ProjectionRecords<K>),
      streamDomainEvents: Stream.empty,
    });
    // Built into the test's scope, so the router's event and sweep fibers live for the test.
    const services = yield* Layer.build(
      withAccountRouter(orchestrator).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(input.providers) }),
            serverSettingsLayerTest({ accountRoutingEnabled: input.routingEnabled ?? true }),
          ),
        ),
      ),
    );
    return { router: Context.get(services, OrchestratorV2), dispatched, continued, goalQueued };
  });

describe("AccountRouter", () => {
  it.effect("continues a limited thread on another account", () =>
    Effect.gen(function* () {
      const { continued } = yield* makeRouter({
        providers: [provider(HDG, 100), provider(EAP, 20)],
        shells: [limitedShell("limited")],
        runs: [failedRun("limited", HDG)],
      });
      const command = yield* Deferred.await(continued);
      assert.strictEqual(command.type, "message.dispatch");
      if (command.type !== "message.dispatch") return;
      assert.strictEqual(command.manualContinuationOfRunId, RunId.make("limited-run"));
      assert.strictEqual(command.modelSelection?.instanceId, EAP);
      assert.strictEqual(command.modelSelection?.model, OPUS);
      assert.deepStrictEqual(command.dispatchMode, { type: "start_immediately" });
    }).pipe(Effect.scoped),
  );

  it.effect("continues from the run's account after the picker moved the thread", () =>
    Effect.gen(function* () {
      const { continued } = yield* makeRouter({
        providers: [provider(HDG, 100), provider(EAP, 20)],
        shells: [
          limitedShell("switched", {
            providerInstanceId: EAP,
            modelSelection: { instanceId: EAP, model: OPUS },
          }),
        ],
        runs: [failedRun("switched", HDG)],
      });
      const command = yield* Deferred.await(continued);
      assert.strictEqual(
        command.type === "message.dispatch" && command.modelSelection?.instanceId,
        EAP,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("sets the thread's goal again on the new account, after the continuation", () =>
    Effect.gen(function* () {
      const { dispatched, goalQueued } = yield* makeRouter({
        providers: [provider(HDG, 100), provider(EAP, 20)],
        shells: [limitedShell("goal")],
        runs: [failedRun("goal", HDG)],
        providerThreads: [
          { id: "goal-provider-thread", goal: { objective: "all tests pass", status: "active" } },
        ],
      });
      const command = yield* Deferred.await(goalQueued);
      assert.deepStrictEqual(
        command.type === "message.dispatch"
          ? {
              text: command.text,
              instanceId: command.modelSelection?.instanceId,
              mode: command.dispatchMode.type,
            }
          : null,
        { text: "/goal all tests pass", instanceId: EAP, mode: "queue_after_active" },
      );
      const continuation = dispatched.findIndex(
        (sent) => sent.type === "message.dispatch" && sent.manualContinuationOfRunId !== undefined,
      );
      assert.isTrue(continuation >= 0 && continuation < dispatched.indexOf(command));
    }).pipe(Effect.scoped),
  );

  it.effect("starts a new thread on the account with the most room, and its message follows", () =>
    Effect.gen(function* () {
      const { router, dispatched } = yield* makeRouter({
        providers: [provider(HDG, 70), provider(EAP, 10)],
      });
      yield* router.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("create:new"),
        threadId: ThreadId.make("new"),
        projectId: ProjectId.make("project"),
        title: "New thread",
        modelSelection: { instanceId: HDG, model: OPUS },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* router.dispatch(message("new", HDG));
      assert.deepStrictEqual(
        dispatched.map((command) =>
          "modelSelection" in command ? command.modelSelection?.instanceId : null,
        ),
        [EAP, EAP],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a follow-up on its account while it has room", () =>
    Effect.gen(function* () {
      const { router, dispatched } = yield* makeRouter({
        providers: [provider(HDG, 80), provider(EAP, 5)],
        shells: [shell("busy")],
      });
      yield* router.dispatch(message("busy", HDG));
      const [sent] = dispatched;
      assert.strictEqual(sent?.type === "message.dispatch" && sent.modelSelection?.instanceId, HDG);
    }).pipe(Effect.scoped),
  );

  it.effect("moves a follow-up off a nearly full account", () =>
    Effect.gen(function* () {
      const { router, dispatched } = yield* makeRouter({
        providers: [provider(HDG, 93), provider(EAP, 30)],
        shells: [shell("busy")],
      });
      yield* router.dispatch(message("busy", HDG));
      const [sent] = dispatched;
      assert.strictEqual(sent?.type === "message.dispatch" && sent.modelSelection?.instanceId, EAP);
    }).pipe(Effect.scoped),
  );

  it.effect("passes commands through when routing is off", () =>
    Effect.gen(function* () {
      const { router, dispatched } = yield* makeRouter({
        providers: [provider(HDG, 99), provider(EAP, 5)],
        shells: [shell("busy")],
        routingEnabled: false,
      });
      yield* router.dispatch(message("busy", HDG));
      const [sent] = dispatched;
      assert.strictEqual(sent?.type === "message.dispatch" && sent.modelSelection?.instanceId, HDG);
    }).pipe(Effect.scoped),
  );
});
