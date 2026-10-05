import { describe, expect, it } from "vite-plus/test";

import {
  matchesAgentsTabShortcut,
  planAgentsToggle,
  planTerminalToggle,
  resolveBottomPanelView,
  type BottomPanelTransition,
  type BottomPanelView,
} from "./agentsBottomPanel.logic";

/** Applies a transition the way the hook does, returning the next view. */
function apply(
  state: { terminalOpen: boolean; agentsOpen: boolean },
  transition: BottomPanelTransition,
): { terminalOpen: boolean; agentsOpen: boolean; view: BottomPanelView } {
  const terminalOpen =
    transition.terminal === "open"
      ? true
      : transition.terminal === "close"
        ? false
        : state.terminalOpen;
  const next = { terminalOpen, agentsOpen: transition.agentsOpen };
  return { ...next, view: resolveBottomPanelView({ enabled: true, ...next }) };
}

describe("resolveBottomPanelView", () => {
  it("shows Agents over open terminals", () => {
    expect(resolveBottomPanelView({ enabled: true, terminalOpen: true, agentsOpen: true })).toBe(
      "agents",
    );
  });

  it("falls back to vanilla terminal behavior when the mod is off", () => {
    expect(resolveBottomPanelView({ enabled: false, terminalOpen: true, agentsOpen: true })).toBe(
      "terminal",
    );
    expect(resolveBottomPanelView({ enabled: false, terminalOpen: false, agentsOpen: true })).toBe(
      "closed",
    );
  });
});

describe("bottom panel toggles", () => {
  it("each toggle brings its tab forward, then closes the panel", () => {
    let state = { terminalOpen: false, agentsOpen: false };
    let view: BottomPanelView = "closed";

    ({ view, ...state } = apply(state, planAgentsToggle(view)));
    expect(view).toBe("agents");

    ({ view, ...state } = apply(state, planTerminalToggle(view)));
    expect(view).toBe("terminal");

    ({ view, ...state } = apply(state, planAgentsToggle(view)));
    expect(view).toBe("agents");
    // Terminals keep running behind the Agents tab.
    expect(state.terminalOpen).toBe(true);

    ({ view, ...state } = apply(state, planAgentsToggle(view)));
    expect(view).toBe("closed");
    expect(state).toEqual({ terminalOpen: false, agentsOpen: false });
  });

  it("closes from the terminal tab exactly like vanilla", () => {
    expect(planTerminalToggle("terminal")).toEqual({ agentsOpen: false, terminal: "close" });
    expect(planTerminalToggle("closed")).toEqual({ agentsOpen: false, terminal: "open" });
  });
});

describe("matchesAgentsTabShortcut", () => {
  const press = (overrides: Partial<KeyboardEvent>) => ({
    code: "KeyJ",
    altKey: true,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...overrides,
  });

  it("matches Ctrl+Alt+J off macOS and ⌥⌘J on macOS", () => {
    expect(matchesAgentsTabShortcut(press({ ctrlKey: true }), false)).toBe(true);
    expect(matchesAgentsTabShortcut(press({ metaKey: true }), true)).toBe(true);
  });

  it("leaves neighbouring chords alone", () => {
    expect(matchesAgentsTabShortcut(press({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(matchesAgentsTabShortcut(press({ ctrlKey: true, altKey: false }), false)).toBe(false);
    expect(matchesAgentsTabShortcut(press({ metaKey: true }), false)).toBe(false);
    expect(matchesAgentsTabShortcut(press({ ctrlKey: true, code: "KeyK" }), false)).toBe(false);
  });
});
