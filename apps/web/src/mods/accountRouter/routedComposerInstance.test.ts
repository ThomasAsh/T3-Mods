import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { routedComposerInstance } from "./routedComposerInstance";

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
