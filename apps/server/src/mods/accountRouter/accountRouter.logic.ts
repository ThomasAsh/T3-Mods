/**
 * Account routing policy (t3-mods: account-router). Pure decisions over the
 * provider snapshots the server already keeps; `AccountRouter.ts` applies them.
 *
 * A pool is every usable account of one provider driver. Prompt cache lives
 * per account, so a thread stays on its account until that account is out of
 * room; only then does it move, and only within its pool, on the same model.
 */
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

/** Before a turn starts, an account this close to a limit counts as nearly full. */
export const SESSION_RESERVE_PERCENT = 90;
export const WEEKLY_RESERVE_PERCENT = 97;
/** Weekly allowance that resets this soon is used first while it has this much left. */
const EXPIRING_WITHIN_MS = 24 * 60 * 60 * 1000;
const EXPIRING_MIN_REMAINING_PERCENT = 10;

export interface RoutingAccount {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  /** Model slugs the account offers; empty when the snapshot lists none. */
  readonly models: ReadonlySet<string>;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  /** Reset time of a usage-limit failure seen on this account, if it is still ahead. */
  readonly blockedUntilMs: number | null;
}

export type AccountHealth =
  | { readonly state: "healthy" }
  | { readonly state: "near"; readonly window: ServerProviderUsageWindow }
  | { readonly state: "blocked"; readonly resetsAtMs: number | null };

function usable(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    (provider.availability ?? "available") === "available" &&
    provider.status !== "error" &&
    provider.status !== "disabled" &&
    provider.auth.status !== "unauthenticated"
  );
}

/**
 * Accounts per driver, for drivers with more than one. Instances that share a
 * config dir are one account (same continuation group), so only the first counts.
 * New instances join their driver's pool as soon as they are usable.
 */
export function routingPools(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly excludedInstanceIds: ReadonlyArray<string>;
  readonly blockedUntilMs: ReadonlyMap<string, number>;
  readonly nowMs: number;
}): ReadonlyMap<string, ReadonlyArray<RoutingAccount>> {
  const excluded = new Set(input.excludedInstanceIds);
  const pools = new Map<string, Array<RoutingAccount>>();
  const seenAccounts = new Set<string>();
  for (const provider of input.providers) {
    if (!usable(provider) || excluded.has(provider.instanceId)) continue;
    const accountKey = `${provider.driver}:${provider.continuation?.groupKey ?? provider.instanceId}`;
    if (seenAccounts.has(accountKey)) continue;
    seenAccounts.add(accountKey);
    const blockedUntil = input.blockedUntilMs.get(provider.instanceId);
    const pool = pools.get(provider.driver) ?? [];
    pool.push({
      instanceId: provider.instanceId,
      label: provider.displayName ?? provider.auth.email ?? provider.instanceId,
      models: new Set(provider.models.map((model) => model.slug)),
      windows: provider.usageLimits?.windows ?? [],
      blockedUntilMs: blockedUntil !== undefined && blockedUntil > input.nowMs ? blockedUntil : null,
    });
    pools.set(provider.driver, pool);
  }
  return new Map([...pools].filter(([, accounts]) => accounts.length > 1));
}

export function poolContaining(
  pools: ReadonlyMap<string, ReadonlyArray<RoutingAccount>>,
  instanceId: string,
): ReadonlyArray<RoutingAccount> | null {
  for (const pool of pools.values()) {
    if (pool.some((account) => account.instanceId === instanceId)) return pool;
  }
  return null;
}

/**
 * Account-wide windows apply to every model. A model-scoped window
 * ("Weekly · Opus") applies when the model slug names that model family.
 */
export function windowAppliesToModel(window: ServerProviderUsageWindow, model: string): boolean {
  const scope = window.label.split("·")[1]?.trim().toLowerCase();
  if (!scope) return true;
  const slug = model.toLowerCase();
  return scope.split(/[^a-z0-9]+/).some((word) => word.length >= 3 && slug.includes(word));
}

function resetMs(window: ServerProviderUsageWindow): number | null {
  if (!window.resetsAt) return null;
  const ms = Date.parse(window.resetsAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Windows that bind this model now; a window past its reset time has rolled over. */
function liveWindows(account: RoutingAccount, model: string, nowMs: number) {
  return account.windows.filter((window) => {
    const resetsAt = resetMs(window);
    return windowAppliesToModel(window, model) && (resetsAt === null || resetsAt > nowMs);
  });
}

export function accountHealth(account: RoutingAccount, model: string, nowMs: number): AccountHealth {
  if (account.blockedUntilMs !== null && account.blockedUntilMs > nowMs) {
    return { state: "blocked", resetsAtMs: account.blockedUntilMs };
  }
  let near: ServerProviderUsageWindow | null = null;
  for (const window of liveWindows(account, model, nowMs)) {
    if (window.usedPercent >= 100) return { state: "blocked", resetsAtMs: resetMs(window) };
    const reserve =
      window.kind === "session" ? SESSION_RESERVE_PERCENT : WEEKLY_RESERVE_PERCENT;
    if (window.usedPercent >= reserve && (near === null || window.usedPercent > near.usedPercent)) {
      near = window;
    }
  }
  return near === null ? { state: "healthy" } : { state: "near", window: near };
}

const HEALTH_ORDER = { healthy: 0, near: 1, blocked: 2 } as const;

function offersModel(account: RoutingAccount, model: string): boolean {
  return account.models.size === 0 || account.models.has(model);
}

/**
 * Best account first: healthy before nearly full before blocked; then weekly
 * allowance that would otherwise expire unused; then the most session room,
 * then the most weekly room.
 */
export function rankAccounts(
  accounts: ReadonlyArray<RoutingAccount>,
  model: string,
  nowMs: number,
): ReadonlyArray<RoutingAccount> {
  const scored = accounts
    .filter((account) => offersModel(account, model))
    .map((account) => {
      const windows = liveWindows(account, model, nowMs);
      const used = (kind: ServerProviderUsageWindow["kind"]) =>
        Math.max(0, ...windows.filter((window) => window.kind === kind).map((w) => w.usedPercent));
      const expiring = windows.some((window) => {
        const resetsAt = resetMs(window);
        return (
          window.kind === "weekly" &&
          resetsAt !== null &&
          resetsAt - nowMs <= EXPIRING_WITHIN_MS &&
          100 - window.usedPercent >= EXPIRING_MIN_REMAINING_PERCENT
        );
      });
      return {
        account,
        health: HEALTH_ORDER[accountHealth(account, model, nowMs).state],
        expiring: expiring ? 0 : 1,
        session: used("session"),
        weekly: used("weekly"),
      };
    });
  scored.sort(
    (left, right) =>
      left.health - right.health ||
      left.expiring - right.expiring ||
      left.session - right.session ||
      left.weekly - right.weekly ||
      left.account.instanceId.localeCompare(right.account.instanceId),
  );
  return scored.map(({ account }) => account);
}

/** A brand-new thread has no cache to keep, so it starts on the best account. */
export function chooseForNewThread(input: {
  readonly pool: ReadonlyArray<RoutingAccount>;
  readonly requested: ProviderInstanceId;
  readonly model: string;
  readonly nowMs: number;
}): ProviderInstanceId {
  const best = rankAccounts(input.pool, input.model, input.nowMs)[0];
  if (!best || accountHealth(best, input.model, input.nowMs).state === "blocked") {
    return input.requested;
  }
  return best.instanceId;
}

/**
 * A message to a thread that already has history. The requested account (the
 * thread's own, or one the user picked) is kept while it has room. Otherwise
 * the thread's current account is preferred, since its cache is warm, then the
 * best healthy account. A nearly full account with no healthy alternative is
 * kept, since it may still finish the turn.
 */
export function chooseForFollowUp(input: {
  readonly pool: ReadonlyArray<RoutingAccount>;
  readonly current: ProviderInstanceId | null;
  readonly requested: ProviderInstanceId;
  readonly model: string;
  readonly nowMs: number;
}): ProviderInstanceId {
  const health = (instanceId: ProviderInstanceId | null) => {
    const account = input.pool.find((candidate) => candidate.instanceId === instanceId);
    return account && offersModel(account, input.model)
      ? accountHealth(account, input.model, input.nowMs).state
      : null;
  };
  const requestedHealth = health(input.requested);
  if (requestedHealth === "healthy" || requestedHealth === null) return input.requested;
  if (input.current !== null && health(input.current) === "healthy") return input.current;
  const alternatives = input.pool.filter((account) => account.instanceId !== input.requested);
  const best = rankAccounts(alternatives, input.model, input.nowMs)[0];
  const bestHealth = best ? accountHealth(best, input.model, input.nowMs).state : null;
  if (best && bestHealth === "healthy") return best.instanceId;
  if (best && requestedHealth === "blocked" && bestHealth === "near") return best.instanceId;
  return input.requested;
}

/** Where a run that hit a usage limit on `from` continues, or null to wait for the reset. */
export function chooseFailover(input: {
  readonly pool: ReadonlyArray<RoutingAccount>;
  readonly from: ProviderInstanceId;
  readonly model: string;
  readonly nowMs: number;
}): RoutingAccount | null {
  const alternatives = input.pool.filter((account) => account.instanceId !== input.from);
  const best = rankAccounts(alternatives, input.model, input.nowMs)[0];
  if (!best || accountHealth(best, input.model, input.nowMs).state === "blocked") return null;
  return best;
}

/**
 * A provider-native `/goal` lives in the account's own session, so a thread that
 * moves leaves it behind. Returns the objective to set again on the new account
 * when the goal was still being worked on (not met, paused or out of budget).
 */
export function goalToCarry(
  goal: { readonly objective: string; readonly status: string } | null | undefined,
): string | null {
  return goal && (goal.status === "active" || goal.status === "usage_limited")
    ? goal.objective
    : null;
}

/**
 * Queued messages that follow a thread to its new account: plain messages
 * queued for the account it left, in delivery order. Messages with
 * attachments or from automations (task results, notifications, schedules)
 * stay where they were queued.
 */
export function requeueableMessages<
  Run extends { readonly providerInstanceId: string; readonly userMessageId: string },
  Message extends {
    readonly id: string;
    readonly attachments: ReadonlyArray<unknown>;
    readonly delegatedCompletion?: unknown;
    readonly notification?: unknown;
    readonly scheduledTaskId?: unknown;
  },
>(input: {
  readonly queuedRuns: ReadonlyArray<Run>;
  readonly messages: ReadonlyArray<Message>;
  readonly from: string;
}): ReadonlyArray<{ readonly run: Run; readonly message: Message }> {
  return input.queuedRuns.flatMap((run) => {
    if (run.providerInstanceId !== input.from) return [];
    const message = input.messages.find((candidate) => candidate.id === run.userMessageId);
    return message &&
      message.attachments.length === 0 &&
      message.delegatedCompletion === undefined &&
      message.notification === undefined &&
      message.scheduledTaskId === undefined
      ? [{ run, message }]
      : [];
  });
}
