import { resolvePendingHandoff } from "@t3tools/client-runtime/handoff";
import {
  ProviderInstanceId,
  RunId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { routedComposerInstance, routedPreviewSelection } from "./routedComposerInstance";

const HDG = ProviderInstanceId.make("claudeAgent");
const EAP = ProviderInstanceId.make("claudeAgent_eap");
const THIRD = ProviderInstanceId.make("claudeAgent_three");

/** A thread the router moved from EAP to HDG. */
const movedThread = {
  providerInstanceHistory: [EAP, HDG],
  runtime: null,
  modelSelection: { instanceId: HDG, model: "claude-opus-5-5" },
};

describe("routedComposerInstance", () => {
  it("follows the thread when the saved pick is an account it left", () => {
    expect(
      routedComposerInstance({ draftInstanceId: EAP, thread: movedThread, routingActive: true }),
    ).toBe(HDG);
  });

  it("keeps a pick of an account the thread never used", () => {
    expect(
      routedComposerInstance({ draftInstanceId: THIRD, thread: movedThread, routingActive: true }),
    ).toBe(THIRD);
  });

  it("keeps the saved pick where the router does not run", () => {
    expect(
      routedComposerInstance({ draftInstanceId: EAP, thread: movedThread, routingActive: false }),
    ).toBe(EAP);
  });
});

describe("routedPreviewSelection", () => {
  const savedEap: ModelSelection = { instanceId: EAP, model: "claude-opus-5-5" };
  const savedThird: ModelSelection = { instanceId: THIRD, model: "claude-opus-5-5" };
  /** The moved thread's latest run, on HDG. */
  const projection = {
    runs: [
      {
        id: RunId.make("latest"),
        ordinal: 2,
        providerInstanceId: HDG,
        modelSelection: movedThread.modelSelection,
        status: "completed",
        startedAt: "2026-10-15T00:00:00Z",
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const preview = (saved: ModelSelection) =>
    resolvePendingHandoff(
      projection,
      routedPreviewSelection(
        saved,
        routedComposerInstance({
          draftInstanceId: saved.instanceId,
          thread: movedThread,
          routingActive: true,
        }),
      ) ?? movedThread.modelSelection,
      [],
    );

  it("previews no handoff when the saved pick is an account the thread left", () => {
    expect(resolvePendingHandoff(projection, savedEap, [])).not.toBeNull();
    expect(preview(savedEap)).toBeNull();
  });

  it("still previews a handoff to an account the thread never used", () => {
    expect(preview(savedThird)?.to).toEqual({ instanceId: THIRD, model: "claude-opus-5-5" });
  });

  it("passes the saved selection through when the router keeps it", () => {
    expect(routedPreviewSelection(savedThird, THIRD)).toBe(savedThird);
    expect(routedPreviewSelection(savedEap, null)).toBe(savedEap);
    expect(routedPreviewSelection(null, HDG)).toBeNull();
  });
});
