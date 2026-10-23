import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { createEmptyBookingDraft, reduceBookingDraft } from "../../booking/booking-draft.js";
import { projectContactEffects } from "../tool-effects/contact.js";

describe("projectContactEffects CRM-only (no draft writes)", () => {
  it("projects verified update fields instead of requested tool arguments", () => {
    const callId = "call-update-verified";
    const patch = projectContactEffects({
      state: {
        bookingDraft: createEmptyBookingDraft(),
        contactContext: {
          ownership: "telegram",
          contacts: [{ id: "c-owned", firstName: "Existing", phoneNumber: "+380501234567" }],
        },
        agentMessages: [new AIMessage({
          content: "",
          tool_calls: [{
            id: callId,
            name: "update_contact",
            args: { contactId: "c-owned", firstName: "Unverified", lastName: "Requested" },
          }],
        })],
      } as never,
      resultMessages: [new ToolMessage({
        content: JSON.stringify({
          success: true,
          id: "c-owned",
          contactId: "c-owned",
          firstName: "Existing",
          lastName: "Verified",
          phoneNumber: "+380501234567",
          missingFields: [],
        }),
        tool_call_id: callId,
        name: "update_contact",
      })],
    });

    expect(patch.contactContext).toMatchObject({
      ownership: "telegram",
      contacts: [{ id: "c-owned", firstName: "Existing", lastName: "Verified" }],
    });
    expect(patch.contactContext?.contacts[0]).not.toHaveProperty("injected");
  });

  it("updates contactContext on create_contact without setting bookingDraft", () => {
    const draft = reduceBookingDraft(createEmptyBookingDraft(), {
      type: "contact_field_submitted",
      field: "phoneNumber",
      value: "+380501234567",
    });
    const callId = "call-create-1";
    const patch = projectContactEffects({
      state: {
        bookingDraft: draft,
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: callId,
              name: "create_contact",
              args: {
                phoneNumber: "+380501234567",
                firstName: "Smoke",
                lastName: "Tester",
              },
            }],
          }),
        ],
      } as never,
      resultMessages: [
        new ToolMessage({
          content: JSON.stringify({ id: "c-new", missingFields: [] }),
          tool_call_id: callId,
          name: "create_contact",
        }),
      ],
    });

    expect(patch.contactContext).toMatchObject({
      ownership: "telegram",
      contacts: [{ id: "c-new", firstName: "Smoke", lastName: "Tester" }],
    });
    expect(Object.prototype.hasOwnProperty.call(patch, "bookingDraft")).toBe(false);
  });

  it("updates contactContext on link_telegram_to_contact without setting bookingDraft", () => {
    const draft = createEmptyBookingDraft();
    const callId = "call-link-1";
    const patch = projectContactEffects({
      state: {
        bookingDraft: draft,
        contactContext: {
          ownership: "phone",
          contacts: [{ id: "c-expected", phoneNumber: "+380501234567" }],
        },
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: callId,
              name: "link_telegram_to_contact",
              args: { contactId: "c-expected" },
            }],
          }),
        ],
      } as never,
      resultMessages: [
        new ToolMessage({
          content: JSON.stringify({ id: "c-expected" }),
          tool_call_id: callId,
          name: "link_telegram_to_contact",
        }),
      ],
    });

    expect(patch.contactContext).toMatchObject({
      ownership: "telegram",
      contacts: [{ id: "c-expected" }],
    });
    expect(Object.prototype.hasOwnProperty.call(patch, "bookingDraft")).toBe(false);
  });

  it("skips contactContext when link returns a foreign id (read-model hygiene)", () => {
    const callId = "call-link-2";
    const patch = projectContactEffects({
      state: {
        bookingDraft: createEmptyBookingDraft(),
        contactContext: {
          ownership: "phone",
          contacts: [{ id: "c-expected" }],
        },
        agentMessages: [
          new AIMessage({
            content: "",
            tool_calls: [{
              id: callId,
              name: "link_telegram_to_contact",
              args: { contactId: "c-expected" },
            }],
          }),
        ],
      } as never,
      resultMessages: [
        new ToolMessage({
          content: JSON.stringify({ id: "c-other" }),
          tool_call_id: callId,
          name: "link_telegram_to_contact",
        }),
      ],
    });

    expect(Object.prototype.hasOwnProperty.call(patch, "contactContext")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(patch, "bookingDraft")).toBe(false);
  });
});
