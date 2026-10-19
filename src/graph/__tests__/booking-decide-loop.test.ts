import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  createBookingDecideNode,
  effectResultFromToolMessages,
} from "../agent-loop/booking-decide-nodes.js";
import { stampBookingEffect } from "../agent-loop/stamp-booking-effect.js";
import { isRuntimeOriginatedToolAi } from "../agent-loop/runtime-tool-stamp.js";
import { filterToolTape } from "../agent-loop/tools-protocol.js";
import { clinicState } from "./agent-loop-fixtures.js";
import type { PendingEffect } from "../booking-domain/effects.js";

describe("DDD-277 decide/effect adapters", () => {
  it("stamps decide-node tool AIs with runtimeToolOrigin so protocol keeps them", async () => {
    const pending: PendingEffect = {
      id: "eff_1_present_availability",
      expectedRevision: 2,
      effect: { kind: "present_availability", queryKind: "nearest" },
      status: "prepared",
    };
    const stamped = stampBookingEffect(pending);
    expect(stamped.args.__bookingEffectStamp).toBe("bookingEffectV1");

    const decide = createBookingDecideNode();
    const update = await decide(
      clinicState({
        bookingDraft: {
          version: 1,
          mode: "create",
          phase: "date",
          serviceAcceptance: {
            status: "accepted",
            service: { id: "svc-1", name: "Botox", source: "catalog" },
          },
          selectedDate: null,
          selectedSlot: null,
          requestedTime: null,
          note: { status: "unasked" },
          contactId: null,
          pendingCommand: null,
          replacement: null,
          pendingEffect: null,
          slotProvenance: null,
          slotEvidence: null,
        },
        messages: [],
      }),
    );
    const messages = update.agentMessages as AIMessage[] | undefined;
    expect(messages?.length).toBe(1);
    const ai = messages![0]!;
    expect(isRuntimeOriginatedToolAi(ai)).toBe(true);
    expect(ai.tool_calls?.[0]?.name).toBe("present_availability_slots");
    expect(ai.tool_calls?.[0]?.args?.__bookingEffectStamp).toBe("bookingEffectV1");
    const filtered = filterToolTape(
      clinicState({ agentMessages: [ai] }),
      "booking",
    );
    // Protocol keeps runtime-stamped booking tool calls.
    expect(filtered.messagesForTools.some((message) => (
      message instanceof AIMessage
      && (message.tool_calls?.some((call) => call.name === "present_availability_slots") ?? false)
    ))).toBe(true);
  });

  it("translates tool messages into typed effect results", () => {
    const result = effectResultFromToolMessages(
      [
        new ToolMessage({
          content: JSON.stringify({
            result: "none",
            contactIds: [],
          }),
          tool_call_id: "eff_lookup",
          name: "find_contact_by_phone",
        }),
      ],
      "eff_lookup",
    );
    expect(result).toEqual({
      effectId: "eff_lookup",
      kind: "contact_lookup",
      outcome: "none",
      contactIds: [],
    });
  });
});
