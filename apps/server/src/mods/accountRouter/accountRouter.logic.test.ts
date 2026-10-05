import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  accountHealth,
  chooseFailover,
  chooseForFollowUp,
  chooseForNewThread,
  goalToCarry,
  rankAccounts,
  requeueableMessages,
  routingPools,
  windowAppliesToModel,
  type RoutingAccount,
} from "./accountRouter.logic.ts";

const NOW = Date.parse("2026-10-06T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const OPUS = "claude-opus-5-5";
const HDG = ProviderInstanceId.make("claudeAgent");
const EAP = ProviderInstanceId.make("claudeAgent_eap");
const THIRD = ProviderInstanceId.make("claudeAgent_three");

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const session = (usedPercent: number, resetsInHours = 3): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  resetsAt: iso(NOW + resetsInHours * HOUR),
});
const weekly = (usedPercent: number, resetsInHours = 100): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  resetsAt: iso(NOW + resetsInHours * HOUR),
});

const account = (
  instanceId: ProviderInstanceId,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  overrides: Partial<RoutingAccount> = {},
): RoutingAccount => ({
  instanceId,
  label: instanceId,
  models: new Set([OPUS]),
  windows,
  blockedUntilMs: null,
  ...overrides,
});

const provider = (
  instanceId: ProviderInstanceId,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: iso(NOW),
  models: [{ slug: OPUS, name: "Opus", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  continuation: { groupKey: `claude:home:${instanceId}` },
  usageLimits: { checkedAt: iso(NOW), windows: [session(10)] },
  ...overrides,
});

describe("routingPools", () => {
  it("pools usable accounts per driver and skips single-account drivers", () => {
    const pools = routingPools({
      providers: [
        provider(HDG),
        provider(EAP),
        provider(ProviderInstanceId.make("codex"), {
          driver: ProviderDriverKind.make("codex"),
        }),
      ],
      excludedInstanceIds: [],
      blockedUntilMs: new Map(),
      nowMs: NOW,
    });
    assert.deepStrictEqual([...pools.keys()], ["claudeAgent"]);
    assert.deepStrictEqual(
      pools.get("claudeAgent")?.map((entry) => entry.instanceId),
      [HDG, EAP],
    );
  });

  it("counts instances sharing a config dir once, and drops excluded and signed-out ones", () => {
    const pools = routingPools({
      providers: [
        provider(HDG),
        provider(ProviderInstanceId.make("claudeAgent_alias"), {
          continuation: { groupKey: `claude:home:${HDG}` },
        }),
        provider(EAP),
        provider(THIRD, { auth: { status: "unauthenticated" } }),
      ],
      excludedInstanceIds: [],
      blockedUntilMs: new Map(),
      nowMs: NOW,
    });
    assert.deepStrictEqual(
      pools.get("claudeAgent")?.map((entry) => entry.instanceId),
      [HDG, EAP],
    );
    const withoutEap = routingPools({
      providers: [provider(HDG), provider(EAP)],
      excludedInstanceIds: [EAP],
      blockedUntilMs: new Map(),
      nowMs: NOW,
    });
    assert.strictEqual(withoutEap.size, 0);
  });

  it("keeps a recorded limit only while its reset is ahead", () => {
    const pools = routingPools({
      providers: [provider(HDG), provider(EAP)],
      excludedInstanceIds: [],
      blockedUntilMs: new Map([
        [HDG, NOW + HOUR],
        [EAP, NOW - HOUR],
      ]),
      nowMs: NOW,
    });
    const [hdg, eap] = pools.get("claudeAgent")!;
    assert.strictEqual(hdg?.blockedUntilMs, NOW + HOUR);
    assert.strictEqual(eap?.blockedUntilMs, null);
  });
});

describe("accountHealth", () => {
  it("is nearly full at the session or weekly reserve, and blocked at 100%", () => {
    assert.strictEqual(accountHealth(account(HDG, [session(89)]), OPUS, NOW).state, "healthy");
    assert.strictEqual(accountHealth(account(HDG, [session(90)]), OPUS, NOW).state, "near");
    assert.strictEqual(accountHealth(account(HDG, [weekly(96)]), OPUS, NOW).state, "healthy");
    assert.strictEqual(accountHealth(account(HDG, [weekly(97)]), OPUS, NOW).state, "near");
    assert.strictEqual(accountHealth(account(HDG, [session(100)]), OPUS, NOW).state, "blocked");
  });

  it("ignores windows that have already reset", () => {
    assert.strictEqual(
      accountHealth(account(HDG, [session(100, -1)]), OPUS, NOW).state,
      "healthy",
    );
  });

  it("is blocked while a recorded limit has not reset", () => {
    const blocked = account(HDG, [session(20)], { blockedUntilMs: NOW + HOUR });
    assert.deepStrictEqual(accountHealth(blocked, OPUS, NOW), {
      state: "blocked",
      resetsAtMs: NOW + HOUR,
    });
  });

  it("applies a model-scoped weekly window only to that model", () => {
    const fable: ServerProviderUsageWindow = {
      id: "seven_day_fable",
      kind: "weekly",
      label: "Weekly · Fable",
      usedPercent: 100,
    };
    assert.isTrue(windowAppliesToModel(fable, "claude-fable-5-1"));
    assert.isFalse(windowAppliesToModel(fable, OPUS));
    assert.isTrue(windowAppliesToModel(session(1), OPUS));
    assert.strictEqual(accountHealth(account(HDG, [fable]), OPUS, NOW).state, "healthy");
    assert.strictEqual(
      accountHealth(account(HDG, [fable]), "claude-fable-5-1", NOW).state,
      "blocked",
    );
  });
});

describe("rankAccounts", () => {
  it("prefers healthy accounts, then the most session room", () => {
    const ranked = rankAccounts(
      [account(HDG, [session(95)]), account(EAP, [session(60)]), account(THIRD, [session(20)])],
      OPUS,
      NOW,
    );
    assert.deepStrictEqual(
      ranked.map((entry) => entry.instanceId),
      [THIRD, EAP, HDG],
    );
  });

  it("uses weekly allowance that is about to expire first", () => {
    const ranked = rankAccounts(
      [
        account(HDG, [session(10), weekly(40, 200)]),
        account(EAP, [session(50), weekly(60, 12)]),
      ],
      OPUS,
      NOW,
    );
    assert.strictEqual(ranked[0]?.instanceId, EAP);
  });

  it("skips accounts that do not offer the model", () => {
    const ranked = rankAccounts(
      [account(HDG, [session(10)], { models: new Set(["claude-sonnet-5-5"]) }), account(EAP, [])],
      OPUS,
      NOW,
    );
    assert.deepStrictEqual(
      ranked.map((entry) => entry.instanceId),
      [EAP],
    );
  });
});

describe("chooseForNewThread", () => {
  it("starts on the account with the most room", () => {
    const pool = [account(HDG, [session(70)]), account(EAP, [session(30)])];
    assert.strictEqual(chooseForNewThread({ pool, requested: HDG, model: OPUS, nowMs: NOW }), EAP);
  });

  it("keeps the requested account when every account is blocked", () => {
    const pool = [account(HDG, [session(100)]), account(EAP, [session(100)])];
    assert.strictEqual(chooseForNewThread({ pool, requested: HDG, model: OPUS, nowMs: NOW }), HDG);
  });
});

describe("chooseForFollowUp", () => {
  it("stays on a healthy account even when another has more room", () => {
    const pool = [account(HDG, [session(80)]), account(EAP, [session(5)])];
    assert.strictEqual(
      chooseForFollowUp({ pool, current: HDG, requested: HDG, model: OPUS, nowMs: NOW }),
      HDG,
    );
  });

  it("moves off a nearly full account to a healthy one", () => {
    const pool = [account(HDG, [session(93)]), account(EAP, [session(40)])];
    assert.strictEqual(
      chooseForFollowUp({ pool, current: HDG, requested: HDG, model: OPUS, nowMs: NOW }),
      EAP,
    );
  });

  it("keeps a nearly full account when no other account is healthy", () => {
    const pool = [account(HDG, [session(93)]), account(EAP, [session(95)])];
    assert.strictEqual(
      chooseForFollowUp({ pool, current: HDG, requested: HDG, model: OPUS, nowMs: NOW }),
      HDG,
    );
  });

  it("leaves a blocked account for a nearly full one", () => {
    const pool = [account(HDG, [session(100)]), account(EAP, [session(95)])];
    assert.strictEqual(
      chooseForFollowUp({ pool, current: HDG, requested: HDG, model: OPUS, nowMs: NOW }),
      EAP,
    );
  });

  it("honours an account the user picked while it has room", () => {
    const pool = [account(HDG, [session(10)]), account(EAP, [session(60)])];
    assert.strictEqual(
      chooseForFollowUp({ pool, current: HDG, requested: EAP, model: OPUS, nowMs: NOW }),
      EAP,
    );
  });

  it("keeps the thread's warm account when a stale pick is blocked", () => {
    const pool = [
      account(HDG, [session(100)]),
      account(EAP, [session(50)]),
      account(THIRD, [session(5)]),
    ];
    assert.strictEqual(
      chooseForFollowUp({ pool, current: EAP, requested: HDG, model: OPUS, nowMs: NOW }),
      EAP,
    );
  });

  it("passes through accounts outside the pool", () => {
    const pool = [account(HDG, [session(100)]), account(EAP, [session(10)])];
    const codex = ProviderInstanceId.make("codex");
    assert.strictEqual(
      chooseForFollowUp({ pool, current: HDG, requested: codex, model: OPUS, nowMs: NOW }),
      codex,
    );
  });
});

describe("chooseFailover", () => {
  it("continues on the best other account", () => {
    const pool = [
      account(HDG, [session(100)]),
      account(EAP, [session(70)]),
      account(THIRD, [session(20)]),
    ];
    assert.strictEqual(
      chooseFailover({ pool, from: HDG, model: OPUS, nowMs: NOW })?.instanceId,
      THIRD,
    );
  });

  it("uses a nearly full account rather than waiting for the reset", () => {
    const pool = [account(HDG, [session(100)]), account(EAP, [session(95)])];
    assert.strictEqual(chooseFailover({ pool, from: HDG, model: OPUS, nowMs: NOW })?.instanceId, EAP);
  });

  it("waits for the reset when every other account is blocked", () => {
    const pool = [account(HDG, [session(100)]), account(EAP, [weekly(100)])];
    assert.isNull(chooseFailover({ pool, from: HDG, model: OPUS, nowMs: NOW }));
  });
});

describe("requeueableMessages", () => {
  const run = (id: string, providerInstanceId: string) => ({
    id,
    providerInstanceId,
    userMessageId: `message-${id}`,
  });
  const message = (id: string, extra: Record<string, unknown> = {}) => ({
    id: `message-${id}`,
    attachments: [] as ReadonlyArray<unknown>,
    ...extra,
  });

  it("moves plain messages queued for the account the thread left, in order", () => {
    const moves = requeueableMessages({
      queuedRuns: [run("a", HDG), run("b", EAP), run("c", HDG)],
      messages: [message("a"), message("b"), message("c")],
      from: HDG,
    });
    assert.deepStrictEqual(
      moves.map(({ run }) => run.id),
      ["a", "c"],
    );
  });

  it("leaves messages with attachments or from automations where they are", () => {
    const moves = requeueableMessages({
      queuedRuns: [run("a", HDG), run("b", HDG), run("c", HDG), run("d", HDG)],
      messages: [
        message("a", { attachments: [{ id: "file" }] }),
        message("b", { delegatedCompletion: { generation: 1 } }),
        message("c", { scheduledTaskId: "task" }),
        message("d", { notification: { kind: "wake" } }),
      ],
      from: HDG,
    });
    assert.deepStrictEqual(moves, []);
  });
});

describe("goalToCarry", () => {
  it("carries a goal that was still being worked on", () => {
    assert.strictEqual(goalToCarry({ objective: "tests pass", status: "active" }), "tests pass");
    assert.strictEqual(
      goalToCarry({ objective: "tests pass", status: "usage_limited" }),
      "tests pass",
    );
  });

  it("leaves met, paused and missing goals alone", () => {
    assert.isNull(goalToCarry({ objective: "tests pass", status: "complete" }));
    assert.isNull(goalToCarry({ objective: "tests pass", status: "paused" }));
    assert.isNull(goalToCarry(null));
    assert.isNull(goalToCarry(undefined));
  });
});
