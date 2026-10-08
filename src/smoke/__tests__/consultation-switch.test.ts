import { describe, expect, it } from "vitest";

import { runConsultationSwitchSmoke } from "../consultation-switch.js";

describe("consultation switch smoke", () => {
  it("resolves switch to Консультація without botox candidate partition", async () => {
    await expect(runConsultationSwitchSmoke()).resolves.toBeUndefined();
  });
});
