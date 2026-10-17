import { describe, expect, it } from "vitest";

import { BOOKING_SYSTEM_PROMPT } from "../booking.js";
import { FAQ_SYSTEM_PROMPT } from "../faq.js";
import { VOICE_SHORTCUTS } from "../voice.js";

const MUTATION_TOOLS = ["create_meeting", "cancel_meeting", "reschedule_meeting"] as const;

describe("DDD-257 prompt contracts", () => {
  it("booking and FAQ prompts keep runtime-ownership boundaries", () => {
    expect(BOOKING_SYSTEM_PROMPT).not.toContain("confirmationGiven");
    for (const tool of MUTATION_TOOLS) {
      expect(BOOKING_SYSTEM_PROMPT).not.toContain(tool);
    }

    expect(BOOKING_SYSTEM_PROMPT).toMatch(/graph owns contact writes/i);
    expect(BOOKING_SYSTEM_PROMPT).toMatch(/DATE\/TIME/i);
    expect(BOOKING_SYSTEM_PROMPT).toMatch(
      /graph announces those outcomes after a committed CRM write/i,
    );

    expect(VOICE_SHORTCUTS).toContain("faq_catalog_action");
    expect(FAQ_SYSTEM_PROMPT).toContain("faq_catalog_action");
  });

  it("FAQ open-picker prices/info keep chips; cannot-choose offers consultation", () => {
    expect(FAQ_SYSTEM_PROMPT).toMatch(
      /price or product-info[\s\S]*keep_catalog/i,
    );
    expect(FAQ_SYSTEM_PROMPT).toMatch(
      /When a catalog picker is open, stop after the quote and emit `keep_catalog`/,
    );
    expect(FAQ_SYSTEM_PROMPT).not.toMatch(
      /Then offer a consultation unless they already said they want that exact procedure/,
    );
    // Price / product examples while picker open must keep_catalog, not offer.
    expect(FAQ_SYSTEM_PROMPT).toMatch(
      /Price while picker open[\s\S]*<faq_catalog_action>keep_catalog<\/faq_catalog_action>/,
    );
    expect(FAQ_SYSTEM_PROMPT).toMatch(
      /Product question while picker open[\s\S]*<faq_catalog_action>keep_catalog<\/faq_catalog_action>/,
    );
    expect(FAQ_SYSTEM_PROMPT).toMatch(
      /який краще\?[\s\S]*<faq_catalog_action>offer_consultation<\/faq_catalog_action>/,
    );
  });
});
