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
  it("keeps conversation text while redacting secrets, phones, emails", () => {
    const input = JSON.stringify({
      user: "Хочу записатись на консультацію",
      assistant: "Яка дата вам зручна?",
      GOOGLE_API_KEY: "AIzaSySecretKeyValue123",
      header: "Authorization: Bearer sk-live-abc",
      phone: "+380501112233",
      email: "patient@example.com",
    });
    const masked = maskLangfusePayload({ data: input });
    expect(typeof masked).toBe("string");
    const parsed = JSON.parse(masked as string) as Record<string, unknown>;
    expect(parsed.user).toBe("Хочу записатись на консультацію");
    expect(parsed.assistant).toBe("Яка дата вам зручна?");
    expect(String(parsed.GOOGLE_API_KEY)).not.toContain("AIzaSySecretKeyValue123");
    expect(String(parsed.header)).not.toContain("sk-live-abc");
    expect(String(parsed.phone)).toBe("[REDACTED_PHONE]");
    expect(String(parsed.email)).toBe("[REDACTED_EMAIL]");
  });

  it("omits checkpoint and CRM dump keys", () => {
    const input = JSON.stringify({
      bookingDraft: { serviceId: "svc-1", note: "secret note" },
      pendingInteraction: { kind: "mutation_confirm" },
      contactContext: { firstName: "Ada", phoneNumber: "+380501112233" },
      contacts: [{ id: "c-1", firstName: "Ada" }],
      messages: [{ role: "human", content: "hi" }],
      meeting_id: "m-1",
    });
    const parsed = JSON.parse(maskLangfusePayload({ data: input }) as string) as Record<
      string,
      unknown
    >;
    expect(parsed.bookingDraft).toEqual({ _omitted: true });
    expect(parsed.pendingInteraction).toEqual({ _omitted: true });
    expect(parsed.contactContext).toEqual({ _omitted: true });
    expect(parsed.contacts).toEqual({ _omitted: true });
    expect(parsed.messages).toEqual({ _omitted: true });
    expect(parsed.meeting_id).toBe("m-1");
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
