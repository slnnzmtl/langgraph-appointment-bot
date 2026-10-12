import { describe, expect, it } from "vitest";

import {
  maskLangfusePayload,
  pickAllowedEventProps,
  toPropagateMetadata,
} from "../privacy.js";

describe("pickAllowedEventProps", () => {
  it("keeps fields_updated and drops unknown keys / names", () => {
    expect(
      pickAllowedEventProps({
        outcome: "success",
        contact_id: "c-1",
        fields_updated: ["firstName", "phoneNumber"],
        changed_fields: ["firstName"],
        firstName: "Ada",
        phoneNumber: "+380501112233",
        telegram_user_id: "42",
      }),
    ).toEqual({
      outcome: "success",
      contact_id: "c-1",
      fields_updated: ["firstName", "phoneNumber"],
      telegram_user_id: "42",
    });
  });
});

describe("maskLangfusePayload", () => {
  it("deny-by-default: drops unknown object keys including conversation-shaped names", () => {
    const input = JSON.stringify({
      user: "Хочу записатись на консультацію",
      assistant: "Яка дата вам зручна?",
      firstName: "Ada",
      lastName: "Lovelace",
      addressStreet: "42 Baker St",
      medicalNote: "hypertension",
      raw_mcp: { contacts: [{ id: "c-1" }] },
      GOOGLE_API_KEY: "AIzaSySecretKeyValue123",
      meeting_id: "m-1",
      contact_id: "c-1",
      outcome: "success",
      fields_updated: ["firstName", "phoneNumber"],
      phone: "+380501112233",
      email: "patient@example.com",
    });
    const masked = maskLangfusePayload({ data: input });
    expect(typeof masked).toBe("string");
    const parsed = JSON.parse(masked as string) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("user");
    expect(parsed).not.toHaveProperty("assistant");
    expect(parsed).not.toHaveProperty("firstName");
    expect(parsed).not.toHaveProperty("lastName");
    expect(parsed).not.toHaveProperty("addressStreet");
    expect(parsed).not.toHaveProperty("medicalNote");
    expect(parsed).not.toHaveProperty("raw_mcp");
    expect(parsed).not.toHaveProperty("phone");
    expect(parsed).not.toHaveProperty("email");
    expect(parsed.meeting_id).toBe("m-1");
    expect(parsed.contact_id).toBe("c-1");
    expect(parsed.outcome).toBe("success");
    expect(parsed.fields_updated).toEqual(["firstName", "phoneNumber"]);
    expect(String(parsed.GOOGLE_API_KEY)).toBe("[REDACTED]");
  });

  it("keeps plain conversation strings after phone/email/secret redaction", () => {
    const text =
      "Хочу записатись; дзвоніть +380501112233 або patient@example.com GOOGLE_API_KEY=AIzaSyLeak";
    const masked = maskLangfusePayload({ data: text });
    expect(String(masked)).toContain("Хочу записатись");
    expect(String(masked)).toContain("[REDACTED_PHONE]");
    expect(String(masked)).toContain("[REDACTED_EMAIL]");
    expect(String(masked)).not.toContain("AIzaSyLeak");
    expect(String(masked)).not.toContain("+380501112233");
  });

  it("drops checkpoint and CRM dump keys (no nested copy)", () => {
    const input = JSON.stringify({
      bookingDraft: { serviceId: "svc-1", note: "secret note" },
      pendingInteraction: { kind: "mutation_confirm" },
      contactContext: { firstName: "Ada", phoneNumber: "+380501112233" },
      contacts: [{ id: "c-1", firstName: "Ada" }],
      messages: [{ role: "human", content: "hi" }],
      meeting_id: "m-1",
      missing_fields: ["phoneNumber", "addressStreet"],
    });
    const parsed = JSON.parse(maskLangfusePayload({ data: input }) as string) as Record<
      string,
      unknown
    >;
    expect(parsed).not.toHaveProperty("bookingDraft");
    expect(parsed).not.toHaveProperty("pendingInteraction");
    expect(parsed).not.toHaveProperty("contactContext");
    expect(parsed).not.toHaveProperty("contacts");
    expect(parsed).not.toHaveProperty("messages");
    expect(parsed.meeting_id).toBe("m-1");
    expect(parsed.missing_fields).toEqual(["phoneNumber", "addressStreet"]);
  });

  it("redacts secrets in non-JSON strings", () => {
    const masked = maskLangfusePayload({
      data: "ESPOcrm dump GOOGLE_API_KEY=AIzaSyLeak +380671112233",
    });
    expect(String(masked)).not.toContain("AIzaSyLeak");
    expect(String(masked)).toContain("[REDACTED_PHONE]");
  });
});

describe("toPropagateMetadata", () => {
  it("stringifies and truncates to 200 chars", () => {
    const long = "x".repeat(250);
    expect(toPropagateMetadata({ source: "smoke", n: 3, long })).toEqual({
      source: "smoke",
      n: "3",
      long: "x".repeat(200),
    });
  });
});
