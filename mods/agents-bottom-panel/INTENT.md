# Mod: Agents tab in the bottom panel

## What it must do

- The bottom panel (where the terminal lives) has a tab row: **Terminal** | **Agents ●n**. The badge counts the current turn's subagents that are still working. This is an addition; the terminal works exactly as before.
- **Agents** shows the thread's agents: running and previous subagents, forks and parent threads. The content is upstream's lineage panel (`ThreadRelationshipsPanel`), which replaced the old right-panel Agents surface; the tab hosts it as-is. Clicking a row opens that thread. A thread with no agents shows "No agents on this thread yet."
- Terminals stay mounted while Agents is showing, so running processes keep going and switching back is instant.
- Both tabs share one height, the thread's stored terminal height. Resizing either tab resizes both.
- Agents can be shown on threads with no project or terminal; the Terminal tab is then disabled.
- Entry points are symmetric. Each one brings its tab forward, or closes the panel if that tab is already showing:
  - The terminal toggle: Ctrl+J and the header bottom-panel button.
  - The Agents shortcut: **Ctrl+Alt+J** (⌥⌘J on macOS). A user keybinding on that chord wins.
  - The tab row itself.
- *Settings › General › Agents in bottom panel* switches the mod on or off. It's on by default and findable in settings search. When off, everything behaves exactly like vanilla.
- State is client-only (localStorage `t3mods:agents-bottom-panel:v1`), with no contract or server changes, so the mod works against vanilla and remote servers.
- Mobile: not applicable, since it has no bottom panel. Mobile has its own Agents sheet upstream.

## Where it hooks in (`git grep t3-mods: -- apps/web`)

| Upstream file | Hook |
|---|---|
| `components/ChatView.tsx` | Calls `useAgentsBottomPanel` right after `toggleTerminalVisibility`. Ctrl+J (`terminal.toggle` in the keydown handler) and `panelToggleControlProps` (`terminalOpen`, `onToggleTerminal`) go through `toggleBottomPanelTerminal`. The drawer map passes `active` (false behind the Agents tab) and `agentsTabLiveCount`. `<AgentsBottomPane>` renders after the drawer map. |
| `components/ThreadTerminalDrawer.tsx` | A `header` prop renders the tab row in drawer mode. The floating toolbar offset sits inside it. An effect adopts external height changes. |
| `components/settings/SettingsPanels.tsx` | `<AgentsBottomPanelSettingsRow />` sits after "Proactive panels". |
| `components/settings/settingsSearch.ts` | Search item `agents-bottom-panel`. |

Code lives in `apps/web/src/mods/agentsBottomPanel/`. The toggle semantics are in `agentsBottomPanel.logic.ts`, covered by tests. The live count comes from `environmentThreadDetails.turnSubagentsAtom(ref).liveCount` (the same roster mobile's `ThreadAgentsSheet` uses).

## History and upstream changes to port across

- v0.0.45 had a right-panel Agents surface (`AgentsPanel`, fed by `agentPanelModel`), a live-agent badge on the header toggle, and a "View" button on the "N agents working" banner. The new orchestrator (v0.0.46 nightlies) deleted all three. The tab now hosts `ThreadRelationshipsPanel`, and the badge and banner hooks are gone with their upstream counterparts.
- If upstream renames or moves `ThreadRelationshipsPanel`, host its successor (whatever the thread details panel shows under "Lineage"). Don't copy it into the mod.
- If upstream adds its own tab row or panel host to the bottom drawer, register Agents there instead of keeping our row.
