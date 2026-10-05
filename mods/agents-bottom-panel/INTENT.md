# Mod: Agents tab in the bottom panel

## What it must do

- The bottom panel (where the terminal lives) has a tab row: **Terminal** | **Agents ●n**. The badge shows the live agent count. This is an addition; the terminal works exactly as before.
- **Agents** shows the thread's subagent/workflow roster with live status, activity and tokens. This is the same view as the right-panel "Agents" surface, while upstream still ships that surface.
- Terminals stay mounted while Agents is showing, so running processes keep going and switching back is instant.
- Both tabs share one height, the thread's stored terminal height. Resizing either tab resizes both.
- Agents can be shown on threads with no project or terminal; the Terminal tab is then disabled.
- Entry points are symmetric. Each one brings its tab forward, or closes the panel if that tab is already showing:
  - The terminal toggle: Ctrl+J and the header bottom-panel button.
  - The Agents shortcut: **Ctrl+Alt+J** (⌥⌘J on macOS). A user keybinding on that chord wins.
  - The tab row itself.
  - "View" on the "N agents working" banner opens the bottom Agents tab when the mod is on.
- While Agents is on screen, the header's live-agent badge and the banner's "View" button are hidden.
- *Settings › General › Agents in bottom panel* switches the mod on or off. It's on by default and findable in settings search. When off, everything behaves exactly like vanilla.
- State is client-only (localStorage `t3mods:agents-bottom-panel:v1`), with no contract or server changes, so the mod works against vanilla and remote servers.
- Mobile: not applicable, since it has no bottom panel.

## Where it hooks in (`git grep t3-mods: -- apps/web`)

| Upstream file | Hook |
|---|---|
| `components/ChatView.tsx` | Calls `useAgentsBottomPanel` after `toggleTerminalVisibility`. Ctrl+J and the header toggle call `toggleBottomPanelTerminal`. The drawer `active` flag and `agentsTabLiveCount` are passed in the drawer map. `<AgentsBottomPane>` renders after the drawers. The banner's View button and badge suppression are wired here too. |
| `components/ThreadTerminalDrawer.tsx` | A `header` prop renders the tab row in drawer mode. The floating toolbar offset sits inside it. An effect adopts external height changes. |
| `components/settings/SettingsPanels.tsx` | `<AgentsBottomPanelSettingsRow />` sits after "Proactive panels". |
| `components/settings/settingsSearch.ts` | Search item `agents-bottom-panel`. |

Code lives in `apps/web/src/mods/agentsBottomPanel/`. The toggle semantics are in `agentsBottomPanel.logic.ts`, covered by tests.

## Known upstream changes to port across

- **Upstream `main` (new orchestrator, #2829) deletes `components/AgentsPanel.tsx` and the right-panel `agents` surface.** Lineage moved to the thread title bar, and subagents became child threads.
  - When this lands, the mod keeps the roster alive itself:
    - Copy the last upstream `AgentsPanel` into `mods/agentsBottomPanel/` and feed it from the new data. Use `environmentThreadDetails.turnSubagentsAtom(ref)`: the per-turn roster, the same as mobile's `ThreadAgentsSheet`. Add the thread's subagent child threads (`ThreadRelationshipsPanel` data).
    - Keep the tab, toggles and settings unchanged.
  - The ChatView hooks named above move with the new ChatView. `agentPanelModel` is replaced by the new roster's live count.
- If upstream adds its own tab row or panel host to the bottom drawer, register Agents there instead of keeping our row.
