import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useServerConfigs } from "~/state/entities";
import type { Thread } from "~/types";

import { routedComposerInstance } from "./routedComposerInstance";

/** `routedComposerInstance` for the thread's environment, when that server runs the router. */
export function useRoutedComposerInstance(
  environmentId: EnvironmentId,
  thread: Pick<Thread, "providerInstanceHistory" | "runtime" | "modelSelection"> | undefined,
  draftInstanceId: ProviderInstanceId | null,
): ProviderInstanceId | null {
  const routingEnabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.accountRoutingEnabled,
  );
  const routerRuns =
    useServerConfigs().get(environmentId)?.environment.capabilities.accountRouting === true;
  return routedComposerInstance({
    draftInstanceId,
    thread,
    routingActive: routingEnabled && routerRuns,
  });
}
