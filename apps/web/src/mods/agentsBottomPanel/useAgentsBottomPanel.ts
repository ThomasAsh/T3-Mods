import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { resolveShortcutCommand } from "~/keybindings";
import { isMacPlatform } from "~/lib/utils";

import {
  matchesAgentsTabShortcut,
  planAgentsToggle,
  planTerminalToggle,
  resolveBottomPanelView,
  type BottomPanelTransition,
  type BottomPanelView,
} from "./agentsBottomPanel.logic";
import { selectAgentsOpen, useAgentsBottomPanelStore } from "./agentsBottomPanelStore";

/**
 * Bottom panel controller for the active thread. ChatView routes its terminal toggle
 * (Ctrl+J and the header button) through `toggleTerminal`; with the mod off that is
 * exactly the vanilla toggle.
 */
export function useAgentsBottomPanel(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly terminalOpen: boolean;
  /** Vanilla toggle: opens (creating a first terminal if needed) or closes the drawer. */
  readonly toggleTerminalDrawer: () => void;
  readonly setTerminalOpen: (open: boolean) => void;
  readonly keybindings: ResolvedKeybindingsConfig;
}): {
  readonly enabled: boolean;
  readonly view: BottomPanelView;
  /** True when Agents opened from a closed panel, so the open animation should play. */
  readonly animateOpen: boolean;
  readonly toggleTerminal: () => void;
  readonly toggleAgents: () => void;
  readonly showAgents: () => void;
} {
  const { threadRef, terminalOpen, toggleTerminalDrawer, setTerminalOpen, keybindings } = input;
  const enabled = useAgentsBottomPanelStore((state) => state.enabled);
  const agentsOpen = useAgentsBottomPanelStore((state) => selectAgentsOpen(state, threadRef));
  const view = resolveBottomPanelView({ enabled, terminalOpen, agentsOpen });

  const [viewHistory, setViewHistory] = useState({ view, animateOpen: false });
  if (viewHistory.view !== view) {
    setViewHistory({ view, animateOpen: view === "agents" && viewHistory.view === "closed" });
  }

  const apply = useCallback(
    (transition: BottomPanelTransition) => {
      if (!threadRef) return;
      useAgentsBottomPanelStore.getState().setAgentsOpen(threadRef, transition.agentsOpen);
      if (transition.terminal === "close" && terminalOpen) setTerminalOpen(false);
      if (transition.terminal === "open" && !terminalOpen) toggleTerminalDrawer();
    },
    [setTerminalOpen, terminalOpen, threadRef, toggleTerminalDrawer],
  );

  const toggleTerminal = useCallback(() => {
    if (!enabled) {
      toggleTerminalDrawer();
      return;
    }
    apply(planTerminalToggle(view));
  }, [apply, enabled, toggleTerminalDrawer, view]);

  const toggleAgents = useCallback(() => {
    if (enabled) apply(planAgentsToggle(view));
  }, [apply, enabled, view]);

  const showAgents = useCallback(() => {
    if (enabled) apply({ agentsOpen: true, terminal: "keep" });
  }, [apply, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const isMac = isMacPlatform(navigator.platform);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesAgentsTabShortcut(event, isMac)) return;
      // A user keybinding on the same chord takes precedence over the mod.
      if (resolveShortcutCommand(event, keybindings) !== null) return;
      event.preventDefault();
      event.stopPropagation();
      toggleAgents();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [enabled, keybindings, toggleAgents]);

  return {
    enabled,
    view,
    animateOpen: viewHistory.animateOpen,
    toggleTerminal,
    toggleAgents,
    showAgents,
  };
}
