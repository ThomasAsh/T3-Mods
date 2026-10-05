import type { ProviderInstanceId } from "@t3tools/contracts";

import type { Thread } from "~/types";

/**
 * The account the composer shows and sends for a thread (t3-mods: account-router).
 * The composer remembers the account a thread was started on or last picked, so
 * after the router moves the thread that pick names an account the thread left.
 * The router keeps the thread where it is regardless, so the composer follows
 * the thread instead of showing an account it no longer runs on.
 */
export function routedComposerInstance(input: {
  readonly draftInstanceId: ProviderInstanceId | null;
  readonly thread:
    | Pick<Thread, "providerInstanceHistory" | "runtime" | "modelSelection">
    | undefined;
  readonly routingActive: boolean;
}): ProviderInstanceId | null {
  const { draftInstanceId, thread } = input;
  if (!input.routingActive || draftInstanceId === null || thread === undefined) {
    return draftInstanceId;
  }
  const current = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  return draftInstanceId !== current && thread.providerInstanceHistory.includes(draftInstanceId)
    ? current
    : draftInstanceId;
}
