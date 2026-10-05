import { SettingResetButton, SettingsRow } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import { Switch } from "~/components/ui/switch";
import { formatShortcutLabel } from "~/keybindings";

import { AGENTS_TAB_SHORTCUT } from "./agentsBottomPanel.logic";
import { useAgentsBottomPanelStore } from "./agentsBottomPanelStore";

/** Settings › General row for the Agents bottom tab (client-only, per device). */
export function AgentsBottomPanelSettingsRow() {
  const enabled = useAgentsBottomPanelStore((state) => state.enabled);
  const setEnabled = useAgentsBottomPanelStore((state) => state.setEnabled);
  return (
    <SettingsRow
      {...searchableSetting("agents-bottom-panel")}
      description={`Add an Agents tab next to the terminal in the bottom panel. ${formatShortcutLabel(
        AGENTS_TAB_SHORTCUT,
      )} switches to it.`}
      resetAction={
        enabled ? null : (
          <SettingResetButton label="agents in bottom panel" onClick={() => setEnabled(true)} />
        )
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => setEnabled(Boolean(checked))}
          aria-label="Agents in bottom panel"
        />
      }
    />
  );
}
