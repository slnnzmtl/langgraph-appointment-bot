import { describe, expect, it } from "vitest";

import { unescapeModelLineBreaks } from "../message-content.js";

describe("unescapeModelLineBreaks", () => {
  it("leaves real newlines alone", () => {
    expect(unescapeModelLineBreaks("a\n\nb")).toBe("a\n\nb");
  });

  it("decodes slash-n sequences", () => {
    expect(unescapeModelLineBreaks("a\\n\\nb")).toBe("a\n\nb");
  });
});
