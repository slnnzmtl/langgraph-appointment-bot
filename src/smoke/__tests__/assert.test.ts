import { describe, expect, it } from "vitest";

import {
  CONTROL_MARKUP_LEAK,
  expectNoControlMarkup,
  SmokeAssertError,
} from "../assert.js";

describe("expectNoControlMarkup", () => {
  it("passes normal Ukrainian prose", () => {
    expect(() =>
      expectNoControlMarkup(
        "hours",
        "Ми працюємо з понеділка по п'ятницю з 10:00 до 19:00.",
      ),
    ).not.toThrow();
  });

  it.each([
    "<faq_catalog_action>close_catalog</faq_catalog_action>",
    '<faq_catalog_action action="keep_catalog"/>',
    "<reply_buttons>\nТак\n</reply_buttons>",
    "<yield_to_supervisor/>",
    "<tool_call>create_meeting</tool_call>",
  ])("rejects leaked markup: %s", (leak) => {
    expect(CONTROL_MARKUP_LEAK.test(`Текст.\n${leak}`)).toBe(true);
    expect(() => expectNoControlMarkup("leak", `Текст.\n${leak}`)).toThrow(
      SmokeAssertError,
    );
  });
});
