import { describe, expect, it } from "vitest";

import {
  getTelegramUserId,
  runWithTelegramUserId,
} from "../telegram-user-context.js";

describe("telegram-user-context ALS", () => {
  it("throws when no context is active", () => {
    expect(() => getTelegramUserId()).toThrow(/Telegram user id is not set/);
  });

  it("returns the id inside runWithTelegramUserId", () => {
    const id = runWithTelegramUserId("tg-1", () => getTelegramUserId());
    expect(id).toBe("tg-1");
  });

  it("isolates concurrent async contexts", async () => {
    const seen: string[] = [];

    const left = runWithTelegramUserId("tg-left", async () => {
      await new Promise((r) => setTimeout(r, 20));
      seen.push(getTelegramUserId());
      return getTelegramUserId();
    });

    const right = runWithTelegramUserId("tg-right", async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(getTelegramUserId());
      return getTelegramUserId();
    });

    const [leftId, rightId] = await Promise.all([left, right]);
    expect(leftId).toBe("tg-left");
    expect(rightId).toBe("tg-right");
    expect(seen).toEqual(["tg-right", "tg-left"]);
  });
});
