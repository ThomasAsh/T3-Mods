import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { Bot, TerminalSquare } from "lucide-react";
import { memo, type ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatShortcutLabel, shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";

import { AGENTS_TAB_SHORTCUT, type BottomPanelView } from "./agentsBottomPanel.logic";
import { useAgentsBottomPanelStore } from "./agentsBottomPanelStore";

/** Tab strip at the top of the bottom panel. Same row in the terminal drawer and the Agents pane. */
export const BottomPanelTabs = memo(function BottomPanelTabs({
  view,
  liveCount,
  terminalAvailable,
  terminalShortcutLabel,
  onSelectTerminal,
  onSelectAgents,
}: {
  view: Exclude<BottomPanelView, "closed">;
  liveCount: number;
  terminalAvailable: boolean;
  terminalShortcutLabel: string | null;
  onSelectTerminal: () => void;
  onSelectAgents: () => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Bottom panel"
      className="flex h-7 shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5"
    >
      <BottomPanelTab
        active={view === "terminal"}
        disabled={!terminalAvailable}
        icon={<TerminalSquare className="size-3.5" />}
        label="Terminal"
        tooltip={
          terminalAvailable
            ? `Terminal${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
            : "Terminal is unavailable for this thread"
        }
        onSelect={onSelectTerminal}
      />
      <BottomPanelTab
        active={view === "agents"}
        icon={<Bot className="size-3.5" />}
        label="Agents"
        tooltip={`Agents (${formatShortcutLabel(AGENTS_TAB_SHORTCUT)})${
          liveCount > 0 ? ` · ${liveCount} working` : ""
        }`}
        badge={
          liveCount > 0 ? (
            <span className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-3xs font-semibold tabular-nums text-white">
              {liveCount}
            </span>
          ) : null
        }
        onSelect={onSelectAgents}
      />
    </div>
  );
});

function BottomPanelTab({
  active,
  disabled = false,
  icon,
  label,
  tooltip,
  badge = null,
  onSelect,
}: {
  active: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  tooltip: string;
  badge?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            onClick={active ? undefined : onSelect}
            className={cn(
              "flex h-5.5 items-center gap-1.5 rounded-md px-2 text-xs",
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
            )}
          />
        }
      >
        {icon}
        <span>{label}</span>
        {badge}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The tab strip as rendered inside the terminal drawer, where Terminal is the active tab.
 * Reads the store directly so the memoized drawer only takes primitive props.
 */
export const TerminalDrawerTabs = memo(function TerminalDrawerTabs({
  threadRef,
  liveCount,
  keybindings,
}: {
  threadRef: ScopedThreadRef;
  liveCount: number;
  keybindings: ResolvedKeybindingsConfig;
}) {
  return (
    <BottomPanelTabs
      view="terminal"
      liveCount={liveCount}
      terminalAvailable
      terminalShortcutLabel={shortcutLabelForCommand(keybindings, "terminal.toggle")}
      onSelectTerminal={noop}
      onSelectAgents={() => useAgentsBottomPanelStore.getState().setAgentsOpen(threadRef, true)}
    />
  );
});

function noop() {}
