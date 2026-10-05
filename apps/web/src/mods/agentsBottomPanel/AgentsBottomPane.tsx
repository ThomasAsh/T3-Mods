import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

import { ThreadRelationshipsPanel } from "~/components/chat/ThreadRelationshipsControl";
import { cn } from "~/lib/utils";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";

import { BottomPanelTabs } from "./BottomPanelTabs";

const MIN_HEIGHT = 180;
const MAX_HEIGHT_RATIO = 0.75;

/** Same bounds as the terminal drawer, so both tabs share one height. */
function clampHeight(height: number): number {
  const max = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * MAX_HEIGHT_RATIO));
  return Math.min(Math.max(Math.round(height), MIN_HEIGHT), max);
}

/**
 * The bottom panel while it shows Agents. Mirrors the terminal drawer's frame: same
 * height (the thread's terminal height), top resize edge and tab row, so switching
 * tabs never moves the layout. The roster is upstream's thread lineage panel (running
 * and previous subagents, forks, parents), the successor of the old Agents surface.
 */
export function AgentsBottomPane({
  threadRef,
  animateOpen,
  liveCount,
  terminalAvailable,
  terminalShortcutLabel,
  onSelectTerminal,
}: {
  threadRef: ScopedThreadRef;
  animateOpen: boolean;
  liveCount: number;
  terminalAvailable: boolean;
  terminalShortcutLabel: string | null;
  onSelectTerminal: () => void;
}) {
  const storedHeight = useTerminalUiStateStore(
    (state) => selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalHeight,
  );
  const setStoredHeight = useTerminalUiStateStore((state) => state.setTerminalHeight);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    height: number;
  } | null>(null);
  // Re-clamping on window resize happens through the render: the stored height is clamped here.
  const [, setWindowEpoch] = useState(0);
  const height = dragHeight ?? clampHeight(storedHeight);

  useEffect(() => {
    const onResize = () => setWindowEpoch((epoch) => epoch + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: height,
        height,
      };
    },
    [height],
  );
  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    drag.height = clampHeight(drag.startHeight + (drag.startY - event.clientY));
    setDragHeight(drag.height);
  }, []);
  const onPointerEnd = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDragHeight(null);
      if (drag.height !== drag.startHeight) setStoredHeight(threadRef, drag.height);
    },
    [setStoredHeight, threadRef],
  );

  return (
    <div
      className={cn(
        "grid shrink-0 grid-rows-[1fr] overflow-clip",
        animateOpen &&
          "[[data-panel-animations=true]_&]:transition-[grid-template-rows] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out [[data-panel-animations=true]_&]:starting:grid-rows-[0fr]!",
      )}
    >
      <div className="min-h-0 overflow-clip">
        <aside
          data-mods-agents-bottom-pane
          aria-label="Agents"
          className="relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
          style={{ height: `${height}px` }}
        >
          <div
            className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
          />
          <BottomPanelTabs
            view="agents"
            liveCount={liveCount}
            terminalAvailable={terminalAvailable}
            terminalShortcutLabel={terminalShortcutLabel}
            onSelectTerminal={onSelectTerminal}
            onSelectAgents={noop}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* The lineage panel renders nothing for a thread with no agents. */}
            <div className="peer empty:hidden">
              <ThreadRelationshipsPanel
                environmentId={threadRef.environmentId}
                threadId={threadRef.threadId}
              />
            </div>
            <p className="hidden px-4 py-6 text-center text-sm text-muted-foreground peer-empty:block">
              No agents on this thread yet.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function noop() {}
