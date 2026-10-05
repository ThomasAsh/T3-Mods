import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

import { ScopedSwitch } from "~/components/settings/ScopedSwitch";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";
import { Switch } from "~/components/ui/switch";

/**
 * Signed-in accounts that can share work: drivers with more than one account.
 * Instances that share a config dir are one account, so only the first is listed.
 */
function routableAccounts(providers: ReadonlyArray<ServerProvider>): ReadonlyArray<ServerProvider> {
  const byDriver = new Map<string, Array<ServerProvider>>();
  const seen = new Set<string>();
  for (const provider of providers) {
    if (!provider.enabled || provider.auth.status === "unauthenticated") continue;
    const key = `${provider.driver}:${provider.continuation?.groupKey ?? provider.instanceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    byDriver.set(provider.driver, [...(byDriver.get(provider.driver) ?? []), provider]);
  }
  return [...byDriver.values()].filter((accounts) => accounts.length > 1).flat();
}

/** Settings › General row for the account router (t3-mods: account-router). */
export function AccountRoutingSettingsRow({
  providers,
}: {
  providers: ReadonlyArray<ServerProvider>;
}) {
  const enabled = useScopedSettings((settings) => settings.accountRoutingEnabled);
  const excluded = useScopedSettings((settings) => settings.accountRoutingExcludedInstanceIds);
  const updateSettings = useUpdateScopedSettings();
  const accounts = routableAccounts(providers);
  const setIncluded = (instanceId: ProviderInstanceId, included: boolean) =>
    updateSettings({
      accountRoutingExcludedInstanceIds: included
        ? excluded.filter((id) => id !== instanceId)
        : [...excluded, instanceId],
    });

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("account-routing")}
      description="When a thread's account hits its usage limit, continue the thread on another account of the same provider and model. New threads start on the account with the most room. Otherwise threads keep their account and its prompt cache."
      settingKeys={["accountRoutingEnabled", "accountRoutingExcludedInstanceIds"]}
      control={
        <ScopedSwitch
          settingKeys={["accountRoutingEnabled"]}
          checked={enabled}
          onCheckedChange={(checked) => updateSettings({ accountRoutingEnabled: Boolean(checked) })}
          aria-label="Route between accounts"
        />
      }
    >
      {enabled && accounts.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0 pt-1 pb-2">
          {accounts.map((account) => {
            const name = account.displayName ?? account.instanceId;
            return (
              <li key={account.instanceId} className="flex min-w-0 items-center gap-2.5 text-xs">
                <Switch
                  size="sm"
                  checked={!excluded.includes(account.instanceId)}
                  onCheckedChange={(checked) => setIncluded(account.instanceId, Boolean(checked))}
                  aria-label={`Route work to ${name}`}
                />
                <span className="font-medium text-foreground">{name}</span>
                {account.auth.email ? (
                  <span className="min-w-0 truncate text-muted-foreground">{account.auth.email}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </SettingsRow>
  );
}
