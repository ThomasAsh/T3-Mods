/**
 * Client-only state for the Agents bottom tab: the feature switch and which threads
 * have the bottom panel on Agents. Kept out of contracts and server settings so the
 * mod works against any server, including vanilla remote environments.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

/** Bounds per-thread entries for threads that were deleted while showing Agents. */
const MAX_REMEMBERED_THREADS = 200;

interface AgentsBottomPanelStoreState {
  enabled: boolean;
  agentsOpenByThreadKey: Record<string, true>;
  setEnabled: (enabled: boolean) => void;
  setAgentsOpen: (threadRef: ScopedThreadRef, open: boolean) => void;
}

export const useAgentsBottomPanelStore = create<AgentsBottomPanelStoreState>()(
  persist(
    (set) => ({
      enabled: true,
      agentsOpenByThreadKey: {},
      setEnabled: (enabled) => set({ enabled }),
      setAgentsOpen: (threadRef, open) =>
        set((state) => {
          const key = scopedThreadKey(threadRef);
          if ((state.agentsOpenByThreadKey[key] === true) === open) return state;
          const next = { ...state.agentsOpenByThreadKey };
          if (open) {
            next[key] = true;
            const keys = Object.keys(next);
            for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_THREADS))) {
              delete next[stale];
            }
          } else {
            delete next[key];
          }
          return { agentsOpenByThreadKey: next };
        }),
    }),
    {
      name: "t3mods:agents-bottom-panel:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        enabled: state.enabled,
        agentsOpenByThreadKey: state.agentsOpenByThreadKey,
      }),
    },
  ),
);

export function selectAgentsOpen(
  state: Pick<AgentsBottomPanelStoreState, "agentsOpenByThreadKey">,
  threadRef: ScopedThreadRef | null | undefined,
): boolean {
  return threadRef ? state.agentsOpenByThreadKey[scopedThreadKey(threadRef)] === true : false;
}
