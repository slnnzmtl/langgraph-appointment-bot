import { createServer, type AddressInfo } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { kyivCalendarDate } from "../../composition/clinic-datetime.js";
import {
  clearReminderConfirmsForTests,
  createReminderWebhookHandler,
  formatReminderMessage,
  listEveningBeforeHitlMeetingIds,
  MAX_REMINDER_BODY_BYTES,
  needsEveningBeforeHitl,
  reminderPayloadSchema,
  REMINDER_HITL_QUESTION,
  REMINDER_WEBHOOK_PATH,
  takeReminderConfirm,
  type ReminderSendMessage,
} from "../reminder-webhook.js";
import {
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  DEFAULT_MENU_HAS_VISITS,
  MAIN_MENU_LABEL,
} from "../telegram-ui.js";

const SECRET = "test-webhook-secret";

const listen = async (
  sendMessage: ReminderSendMessage,
): Promise<{ baseUrl: string; close: () => Promise<void> }> => {
  const handler = createReminderWebhookHandler({ secret: SECRET, sendMessage });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
};

describe("reminderPayloadSchema", () => {
  it("accepts telegramId as string or number and keeps id/status while stripping unknown keys", () => {
    const asNumber = reminderPayloadSchema.parse({
      telegramId: 123456789,
      meetings: [
        {
          id: "m-1",
          name: "Консультація",
          dateStart: "2026-08-22T10:00:00",
          status: "Planned",
          dateEnd: "2026-08-22T10:30:00",
          location: "ignored",
        },
      ],
    });
    expect(asNumber.telegramId).toBe("123456789");
    expect(asNumber.meetings).toEqual([
      {
        id: "m-1",
        name: "Консультація",
        dateStart: "2026-08-22T10:00:00",
        status: "Planned",
      },
    ]);

    const asString = reminderPayloadSchema.parse({
      telegramId: "987",
      meetings: [{ name: "Огляд", dateStart: "2026-08-22T11:00:00" }],
    });
    expect(asString.telegramId).toBe("987");
  });

  it("coerces numeric id and accepts meetingId alias", () => {
    expect(
      reminderPayloadSchema.parse({
        telegramId: "1",
        meetings: [{ id: 42, name: "A", dateStart: "2026-08-22T10:00:00" }],
      }).meetings[0],
    ).toEqual({ id: "42", name: "A", dateStart: "2026-08-22T10:00:00" });

    expect(
      reminderPayloadSchema.parse({
        telegramId: "1",
        meetings: [{ meetingId: "m-9", name: "B", dateStart: "2026-08-22T11:00:00" }],
      }).meetings[0],
    ).toEqual({ id: "m-9", name: "B", dateStart: "2026-08-22T11:00:00" });
  });

  it("rejects empty meetings", () => {
    expect(
      reminderPayloadSchema.safeParse({ telegramId: "1", meetings: [] }).success,
    ).toBe(false);
  });
});

describe("needsEveningBeforeHitl", () => {
  afterEach(() => {
    clearReminderConfirmsForTests();
  });

  it("is true for Kyiv tomorrow Planned meetings with an id", () => {
    const now = new Date("2026-08-21T20:00:00+03:00");
    const tomorrow = kyivCalendarDate(now, 1);
    expect(
      needsEveningBeforeHitl(
        { id: "m-1", name: "A", dateStart: `${tomorrow}T10:00:00`, status: "Planned" },
        now,
      ),
    ).toBe(true);
    expect(
      needsEveningBeforeHitl(
        { id: "m-2", name: "B", dateStart: `${tomorrow}T11:00:00` },
        now,
      ),
    ).toBe(true);
  });

  it("is false for Confirmed, same-day, or missing id", () => {
    const now = new Date("2026-08-21T20:00:00+03:00");
    const tomorrow = kyivCalendarDate(now, 1);
    expect(
      needsEveningBeforeHitl(
        { id: "m-1", name: "A", dateStart: `${tomorrow}T10:00:00`, status: "Confirmed" },
        now,
      ),
    ).toBe(false);
    expect(
      needsEveningBeforeHitl(
        { id: "m-1", name: "A", dateStart: "2026-08-21T21:00:00", status: "Planned" },
        now,
      ),
    ).toBe(false);
    expect(
      needsEveningBeforeHitl(
        { name: "A", dateStart: `${tomorrow}T10:00:00`, status: "Planned" },
        now,
      ),
    ).toBe(false);
  });
});

describe("formatReminderMessage", () => {
  it("uses через N хв when the visit is under an hour away", () => {
    const now = new Date("2026-08-21T12:00:00+03:00");
    const text = formatReminderMessage(
      [{ name: "Консультація", dateStart: "2026-08-21T12:15:00" }],
      now,
    );
    expect(text).toContain("Нагадування: через 15 хв у вас візит.");
    expect(text).toContain("Консультація");
  });

  it("uses за годину when the visit is 60–119 minutes away", () => {
    const now = new Date("2026-08-21T12:00:00+03:00");
    const text = formatReminderMessage(
      [{ name: "Огляд", dateStart: "2026-08-21T13:30:00" }],
      now,
    );
    expect(text).toContain("Нагадування: за годину у вас візит.");
  });

  it("uses сьогодні о HH:mm when the visit is later the same day", () => {
    const now = new Date("2026-08-21T09:00:00+03:00");
    const text = formatReminderMessage(
      [{ name: "Консультація", dateStart: "2026-08-21T16:00:00" }],
      now,
    );
    expect(text).toContain("Нагадування: сьогодні о 16:00 у вас візит.");
    expect(text).toContain("сьогодні");
  });

  it("uses завтра when dateStart is Kyiv tomorrow", () => {
    const now = new Date("2026-08-21T12:00:00+03:00");
    const tomorrow = kyivCalendarDate(now, 1);
    const text = formatReminderMessage(
      [{ name: "Консультація", dateStart: `${tomorrow}T10:00:00` }],
      now,
    );
    expect(text).toContain("Нагадування: завтра у вас запланований візит.");
    expect(text).toContain("Консультація");
    expect(text).toContain("завтра");
    expect(text).toContain("о 10:00");
  });

  it("uses a generic intro for visits more than one day ahead", () => {
    const now = new Date("2026-08-21T12:00:00+03:00");
    const later = kyivCalendarDate(now, 3);
    const text = formatReminderMessage(
      [{ name: "Огляд", dateStart: `${later}T11:00:00` }],
      now,
    );
    expect(text).toContain("Нагадування: у вас запланований візит.");
    expect(text).not.toMatch(/^Нагадування: завтра/m);
    expect(text).toContain("Огляд");
  });

  it("picks the intro from the earliest meeting when several are listed", () => {
    const now = new Date("2026-08-21T12:00:00+03:00");
    const tomorrow = kyivCalendarDate(now, 1);
    const text = formatReminderMessage(
      [
        { name: "Пізніше", dateStart: `${tomorrow}T15:00:00` },
        { name: "Скоро", dateStart: "2026-08-21T12:10:00" },
      ],
      now,
    );
    expect(text).toContain("Нагадування: через 10 хв у вас візит.");
    expect(text.indexOf("Скоро")).toBeLessThan(text.indexOf("Пізніше"));
  });

  it("honors ISO-8601 Z and converts to Kyiv for intro and label", () => {
    const now = new Date("2026-08-21T12:00:00+03:00");
    // 09:15Z == 12:15 Kyiv (EEST)
    const text = formatReminderMessage(
      [{ name: "Консультація", dateStart: "2026-08-21T09:15:00Z" }],
      now,
    );
    expect(text).toContain("Нагадування: через 15 хв у вас візит.");
    expect(text).toContain("о 12:15");
  });

  it("honors ISO-8601 offset (+03:00) without stripping it as wall time", () => {
    const now = new Date("2026-08-21T12:00:00+03:00");
    const text = formatReminderMessage(
      [{ name: "Огляд", dateStart: "2026-08-21T12:15:00+03:00" }],
      now,
    );
    expect(text).toContain("Нагадування: через 15 хв у вас візит.");
    expect(text).toContain("о 12:15");
  });
});

describe("createReminderWebhookHandler", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    clearReminderConfirmsForTests();
    if (close) {
      await close();
      close = undefined;
    }
  });

  it("returns 401 when the secret is missing or wrong", async () => {
    const sendMessage = vi.fn<ReminderSendMessage>();
    const server = await listen(sendMessage);
    close = server.close;

    const missing = await fetch(`${server.baseUrl}${REMINDER_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        telegramId: "1",
        meetings: [{ name: "A", dateStart: "2026-08-22T10:00:00" }],
      }),
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ ok: false, error: "unauthorized" });

    const wrong = await fetch(`${server.baseUrl}${REMINDER_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": "nope",
      },
      body: JSON.stringify({
        telegramId: "1",
        meetings: [{ name: "A", dateStart: "2026-08-22T10:00:00" }],
      }),
    });
    expect(wrong.status).toBe(401);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON or schema", async () => {
    const sendMessage = vi.fn<ReminderSendMessage>();
    const server = await listen(sendMessage);
    close = server.close;

    const badJson = await fetch(`${server.baseUrl}${REMINDER_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": SECRET,
      },
      body: "{",
    });
    expect(badJson.status).toBe(400);

    const badSchema = await fetch(`${server.baseUrl}${REMINDER_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": SECRET,
      },
      body: JSON.stringify({ telegramId: "1", meetings: [] }),
    });
    expect(badSchema.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns 400 when the body exceeds the size cap", async () => {
    const sendMessage = vi.fn<ReminderSendMessage>();
    const server = await listen(sendMessage);
    close = server.close;

    const oversized = "x".repeat(MAX_REMINDER_BODY_BYTES + 1);
    const response = await fetch(`${server.baseUrl}${REMINDER_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": SECRET,
      },
      body: oversized,
    });
    expect(response.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns 502 when Telegram send fails", async () => {
    const sendMessage = vi.fn<ReminderSendMessage>().mockRejectedValue(new Error("tg down"));
    const server = await listen(sendMessage);
    close = server.close;

    const response = await fetch(`${server.baseUrl}${REMINDER_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": SECRET,
      },
      body: JSON.stringify({
        telegramId: "42",
        meetings: [{ name: "Огляд", dateStart: "2026-08-22T11:00:00" }],
      }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "telegram_send_failed" });
  });

  it("returns 200 and sends HTML reminder with has-visit menu", async () => {
    const sendMessage = vi.fn<ReminderSendMessage>().mockResolvedValue({});
    const server = await listen(sendMessage);
    close = server.close;

    const tomorrow = kyivCalendarDate(new Date(), 1);
    const response = await fetch(`${server.baseUrl}${REMINDER_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": SECRET,
      },
      body: JSON.stringify({
        telegramId: 42,
        meetings: [{ name: "Консультація", dateStart: `${tomorrow}T10:00:00` }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, hitl: false });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text, extra] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe("42");
    expect(text).toContain("<b>Консультація</b>");
    expect(text).toContain("завтра");
    expect(text).not.toContain(REMINDER_HITL_QUESTION);
    expect(extra.parse_mode).toBe("HTML");
    expect(extra.reply_markup.keyboard).toEqual([
      [{ text: DEFAULT_MENU_HAS_VISITS[0] }, { text: DEFAULT_MENU_HAS_VISITS[1] }],
      [{ text: DEFAULT_MENU_HAS_VISITS[2] }, { text: MAIN_MENU_LABEL }],
    ]);
  });

  it("returns 200 with confirm keyboard for tomorrow Planned meetings with id", async () => {
    const sendMessage = vi.fn<ReminderSendMessage>().mockResolvedValue({});
    const server = await listen(sendMessage);
    close = server.close;

    const tomorrow = kyivCalendarDate(new Date(), 1);
    const response = await fetch(`${server.baseUrl}${REMINDER_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": SECRET,
      },
      body: JSON.stringify({
        telegramId: "42",
        meetings: [
          {
            id: "meet-1",
            name: "Консультація",
            dateStart: `${tomorrow}T10:00:00`,
            status: "Planned",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, hitl: true });
    const [, text, extra] = sendMessage.mock.calls[0]!;
    expect(text).toContain(REMINDER_HITL_QUESTION);
    expect(extra.reply_markup.keyboard).toEqual([
      [{ text: CONFIRM_YES_LABEL }, { text: CONFIRM_NO_LABEL }],
      [{ text: MAIN_MENU_LABEL }],
    ]);
    expect(takeReminderConfirm("42", CONFIRM_YES_LABEL)).toEqual({
      meetingIds: ["meet-1"],
      status: "Confirmed",
    });
  });

  it("does not HITL when status is already Confirmed", async () => {
    const sendMessage = vi.fn<ReminderSendMessage>().mockResolvedValue({});
    const server = await listen(sendMessage);
    close = server.close;

    const tomorrow = kyivCalendarDate(new Date(), 1);
    const response = await fetch(`${server.baseUrl}${REMINDER_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": SECRET,
      },
      body: JSON.stringify({
        telegramId: "42",
        meetings: [
          {
            id: "meet-1",
            name: "Консультація",
            dateStart: `${tomorrow}T10:00:00`,
            status: "Confirmed",
          },
        ],
      }),
    });

    expect(await response.json()).toEqual({ ok: true, hitl: false });
    expect(listEveningBeforeHitlMeetingIds([
      {
        id: "meet-1",
        name: "Консультація",
        dateStart: `${tomorrow}T10:00:00`,
        status: "Confirmed",
      },
    ])).toEqual([]);
    expect(takeReminderConfirm("42", CONFIRM_YES_LABEL)).toBeNull();
  });

  it("consumes pending confirm on ❌ as Not Held", async () => {
    const sendMessage = vi.fn<ReminderSendMessage>().mockResolvedValue({});
    const server = await listen(sendMessage);
    close = server.close;

    const tomorrow = kyivCalendarDate(new Date(), 1);
    await fetch(`${server.baseUrl}${REMINDER_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": SECRET,
      },
      body: JSON.stringify({
        telegramId: "99",
        meetings: [
          { id: "a", name: "A", dateStart: `${tomorrow}T09:00:00`, status: "Planned" },
          { id: "b", name: "B", dateStart: `${tomorrow}T11:00:00` },
        ],
      }),
    });

    expect(takeReminderConfirm("99", "так")).toBeNull();
    expect(takeReminderConfirm("99", MAIN_MENU_LABEL)).toBeNull();
    // Main menu cleared pending without declining — set up again for ❌
    await fetch(`${server.baseUrl}${REMINDER_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": SECRET,
      },
      body: JSON.stringify({
        telegramId: "99",
        meetings: [
          { id: "a", name: "A", dateStart: `${tomorrow}T09:00:00`, status: "Planned" },
          { id: "b", name: "B", dateStart: `${tomorrow}T11:00:00` },
        ],
      }),
    });
    expect(takeReminderConfirm("99", CONFIRM_NO_LABEL)).toEqual({
      meetingIds: ["a", "b"],
      status: "Not Held",
    });
    expect(takeReminderConfirm("99", CONFIRM_YES_LABEL)).toBeNull();
  });

  it("returns 404 for other paths", async () => {
    const sendMessage = vi.fn<ReminderSendMessage>();
    const server = await listen(sendMessage);
    close = server.close;

    const response = await fetch(`${server.baseUrl}/health`, {
      method: "GET",
      headers: { "X-Webhook-Secret": SECRET },
    });
    expect(response.status).toBe(404);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
