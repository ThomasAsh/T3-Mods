import type { KeybindingShortcut } from "@t3tools/contracts";

/**
 * The bottom panel shows a thread's terminals or its Agents roster. Each entry point
 * brings its own tab forward, or closes the panel when that tab is already showing:
 * the terminal toggle (Ctrl+J, header button) and the Agents shortcut are symmetric.
 */
export type BottomPanelView = "closed" | "terminal" | "agents";

export function resolveBottomPanelView(input: {
  readonly enabled: boolean;
  readonly terminalOpen: boolean;
  readonly agentsOpen: boolean;
}): BottomPanelView {
  if (input.enabled && input.agentsOpen) return "agents";
  return input.terminalOpen ? "terminal" : "closed";
}

/**
 * The next Agents flag and what happens to the terminal drawer. "keep" leaves open
 * terminals running behind the Agents tab so switching back is instant.
 */
export interface BottomPanelTransition {
  readonly agentsOpen: boolean;
  readonly terminal: "open" | "close" | "keep";
}

export function planTerminalToggle(view: BottomPanelView): BottomPanelTransition {
  return view === "terminal"
    ? { agentsOpen: false, terminal: "close" }
    : { agentsOpen: false, terminal: "open" };
}

export function planAgentsToggle(view: BottomPanelView): BottomPanelTransition {
  return view === "agents"
    ? { agentsOpen: false, terminal: "close" }
    : { agentsOpen: true, terminal: "keep" };
}

/** Ctrl+Alt+J (⌥⌘J on macOS). Free in the default keymap; a user binding on the chord wins. */
export const AGENTS_TAB_SHORTCUT: KeybindingShortcut = {
  key: "j",
  modKey: true,
  altKey: true,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
};

export function matchesAgentsTabShortcut(
  event: Pick<KeyboardEvent, "code" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey">,
  isMac: boolean,
): boolean {
  // `code` is layout-independent: Ctrl+Alt is AltGr on some layouts, which changes `key`.
  if (event.code !== "KeyJ" || !event.altKey || event.shiftKey) return false;
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
