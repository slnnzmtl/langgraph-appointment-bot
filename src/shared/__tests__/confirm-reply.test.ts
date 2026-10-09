import { describe, expect, it } from "vitest";

import { MAIN_MENU_LABEL } from "../clinic-constants.js";
import { classifyConfirmReply } from "../confirm-reply.js";

describe("classifyConfirmReply", () => {
  it("maps ✅ and ❌ with optional variation selectors", () => {
    expect(classifyConfirmReply("✅")).toEqual({ kind: "confirmed" });
    expect(classifyConfirmReply("✅\uFE0F")).toEqual({ kind: "confirmed" });
    expect(classifyConfirmReply("❌")).toEqual({ kind: "declined" });
    expect(classifyConfirmReply("❌\uFE0F")).toEqual({ kind: "declined" });
  });

  it("maps normalized main-menu labels to leave, not declined", () => {
    expect(classifyConfirmReply(MAIN_MENU_LABEL)).toEqual({ kind: "leave" });
    expect(classifyConfirmReply("головне меню")).toEqual({ kind: "leave" });
    expect(classifyConfirmReply("MAIN MENU")).toEqual({ kind: "leave" });
  });

  it("treats other text as chat", () => {
    expect(classifyConfirmReply("так")).toEqual({ kind: "chat" });
    expect(classifyConfirmReply("ні")).toEqual({ kind: "chat" });
  });
});
