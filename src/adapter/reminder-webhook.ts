import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Telegraf } from "telegraf";
import { z } from "zod";

import { CLINIC_SLOT_TZ } from "../shared/clinic-constants.js";
import {
  addCalendarDays,
  formatKyivDateTimeLabel,
  formatKyivLocalIso,
  normalizeLocalIsoDatetime,
} from "../tools/availability-slots.js";
import { buildConfirmKeyboard, buildDefaultMenuKeyboard, classifyConfirmReply, formatForTelegram, MAIN_MENU_LABEL } from "./telegram-ui.js";

export const REMINDER_WEBHOOK_PATH = "/webhooks/tomorrow-reminder";
export const MAX_REMINDER_BODY_BYTES = 64 * 1024;

const optionalId = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .pipe(z.string().min(1))
  .optional();

const meetingSchema = z
  .object({
    name: z.string().min(1),
    dateStart: z.string().min(1),
    id: optionalId,
    meetingId: optionalId,
    status: z.string().min(1).optional(),
  })
  .transform(({ meetingId, id, ...rest }) => ({
    ...rest,
    ...(id || meetingId ? { id: id ?? meetingId } : {}),
  }));

export const reminderPayloadSchema = z.object({
  telegramId: z.union([z.string(), z.number()]).transform((value) => String(value)),
  meetings: z.array(meetingSchema).min(1),
});

export type ReminderPayload = z.infer<typeof reminderPayloadSchema>;
export type ReminderMeeting = ReminderPayload["meetings"][number];

export type ReminderReplyMarkup =
  | ReturnType<typeof buildDefaultMenuKeyboard>
  | ReturnType<typeof buildConfirmKeyboard>;

export type ReminderSendMessage = (
  chatId: string,
  text: string,
  extra: { parse_mode: "HTML"; reply_markup: ReminderReplyMarkup },
) => Promise<unknown>;

export const REMINDER_HITL_QUESTION =
  "Підтвердіть візит: ✅ прийдете, ❌ скасувати.";

export const REMINDER_CONFIRMED_ACK = "Дякуємо! Візит підтверджено.";
export const REMINDER_DECLINED_ACK = "Візит скасовано.";
export const REMINDER_STALE_CONFIRM =
  "Це підтвердження вже неактивне. Напишіть «Мій запис», щоб підтвердити або скасувати візит.";

export type ReminderConfirmStatus = "Confirmed" | "Not Held";

/** One Planned meeting held for ✅/❌ until its start (utcMs from last HITL webhook). */
export type ReminderPendingMeeting = {
  id: string;
  utcMs: number;
};

export type ReminderConfirmDecision = {
  meetingIds: string[];
  /** Same starts as consumed; re-arm on CRM update failure. */
  meetings: ReminderPendingMeeting[];
  status: ReminderConfirmStatus;
};

type PendingReminderConfirm = {
  meetings: ReminderPendingMeeting[];
};

const pendingReminderConfirms = new Map<string, PendingReminderConfirm>();

export const clearReminderConfirmsForTests = (): void => {
  pendingReminderConfirms.clear();
};

/** Reminder HITL: Planned (or omitted status) with a meeting id — not Confirmed. */
export const needsEveningBeforeHitl = (meeting: ReminderMeeting): boolean => {
  if (!meeting.id?.trim()) {
    return false;
  }
  if (meeting.status === "Confirmed") {
    return false;
  }
  if (meeting.status !== undefined && meeting.status !== "Planned") {
    return false;
  }
  return true;
};

export const listEveningBeforeHitlMeetingIds = (meetings: ReminderMeeting[]): string[] =>
  meetings.filter(needsEveningBeforeHitl).map((meeting) => meeting.id!.trim());

/** UTC offset of `timeZone` at `instantMs` (ms to add to UTC to get wall clock as UTC components). */
const timeZoneOffsetMs = (instantMs: number, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instantMs));
  const byType = Object.fromEntries(
    parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  const hour = Number(byType.hour) % 24;
  const wallAsUtc = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    hour,
    Number(byType.minute),
    Number(byType.second),
  );
  return wallAsUtc - instantMs;
};

/** True when the string includes an explicit ISO-8601 zone (`Z` or ±HH:MM / ±HHMM). */
export const hasExplicitIsoZone = (value: string): boolean =>
  /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value.trim());

/** Convert Kyiv wall-clock `YYYY-MM-DDTHH:mm:ss` (no zone) to UTC epoch ms. */
export const kyivLocalIsoToUtcMs = (dateStart: string): number => {
  const normalized = normalizeLocalIsoDatetime(dateStart);
  const [year, month, day] = normalized.slice(0, 10).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const [hour, minute, second] = normalized.slice(11).split(":").map(Number) as [
    number,
    number,
    number,
  ];
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = asUtc - timeZoneOffsetMs(asUtc, CLINIC_SLOT_TZ);
  instant = asUtc - timeZoneOffsetMs(instant, CLINIC_SLOT_TZ);
  return instant;
};

export type MeetingStartKyiv = {
  /** Kyiv calendar day YYYY-MM-DD */
  day: string;
  /** Kyiv wall HH:mm */
  time: string;
  /** Absolute instant */
  utcMs: number;
  /** Kyiv wall `YYYY-MM-DDTHH:mm:ss` for label helpers */
  kyivWallIso: string;
};

/**
 * Resolve meeting start to Kyiv wall clock + UTC ms.
 * - With `Z` / ±offset: honor the zone, then convert to Europe/Kyiv for display.
 * - Without zone: treat digits as Kyiv wall time (EspoCRM local ISO).
 */
export const resolveMeetingStartInKyiv = (dateStart: string): MeetingStartKyiv => {
  const trimmed = dateStart.trim();
  if (hasExplicitIsoZone(trimmed)) {
    const utcMs = Date.parse(trimmed);
    if (Number.isNaN(utcMs)) {
      throw new Error(`Invalid datetime: ${dateStart}`);
    }
    const kyivWallIso = formatKyivLocalIso(new Date(utcMs));
    return {
      day: kyivWallIso.slice(0, 10),
      time: kyivWallIso.slice(11, 16),
      utcMs,
      kyivWallIso,
    };
  }
  const kyivWallIso = normalizeLocalIsoDatetime(trimmed);
  return {
    day: kyivWallIso.slice(0, 10),
    time: kyivWallIso.slice(11, 16),
    utcMs: kyivLocalIsoToUtcMs(kyivWallIso),
    kyivWallIso,
  };
};

/** Build pending HITL rows from webhook meetings (skip unparseable dateStart). */
export const reminderPendingFromHitlMeetings = (
  meetings: ReminderMeeting[],
): ReminderPendingMeeting[] => {
  const byId = new Map<string, number>();
  for (const meeting of meetings) {
    if (!needsEveningBeforeHitl(meeting)) {
      continue;
    }
    const id = meeting.id!.trim();
    try {
      byId.set(id, resolveMeetingStartInKyiv(meeting.dateStart).utcMs);
    } catch {
      // skip — do not invent a TTL
    }
  }
  return [...byId.entries()].map(([id, utcMs]) => ({ id, utcMs }));
};

/** Replace pending HITL for this Telegram user (last HITL POST wins). */
export const setReminderConfirmPending = (
  telegramId: string,
  meetings: ReminderPendingMeeting[],
): void => {
  const byId = new Map<string, number>();
  for (const meeting of meetings) {
    const id = meeting.id.trim();
    if (!id || !Number.isFinite(meeting.utcMs)) {
      continue;
    }
    byId.set(id, meeting.utcMs);
  }
  if (byId.size === 0) {
    return;
  }
  pendingReminderConfirms.set(telegramId, {
    meetings: [...byId.entries()].map(([id, utcMs]) => ({ id, utcMs })),
  });
};

/**
 * Consume a pending reminder confirm for ✅ / ❌.
 * Valid until each meeting’s stored start (utcMs from last HITL webhook).
 * «Головне меню» clears without CRM update. Other chat leaves pending in place.
 */
export const takeReminderConfirm = (
  telegramId: string,
  text: string,
  now = Date.now(),
): ReminderConfirmDecision | null => {
  const pending = pendingReminderConfirms.get(telegramId);
  if (!pending) {
    return null;
  }
  const stillFuture = pending.meetings.filter((meeting) => meeting.utcMs > now);
  if (stillFuture.length === 0) {
    pendingReminderConfirms.delete(telegramId);
    return null;
  }
  const trimmed = text.trim();
  if (trimmed === MAIN_MENU_LABEL) {
    pendingReminderConfirms.delete(telegramId);
    return null;
  }
  const decision = classifyConfirmReply(trimmed);
  if (decision.kind === "chat") {
    // Drop expired siblings; keep still-future ids for a later tap.
    pendingReminderConfirms.set(telegramId, { meetings: stillFuture });
    return null;
  }
  pendingReminderConfirms.delete(telegramId);
  return {
    meetingIds: stillFuture.map((meeting) => meeting.id),
    meetings: stillFuture,
    status: decision.kind === "confirmed" ? "Confirmed" : "Not Held",
  };
};

/** Ukrainian intro from earliest meeting vs Kyiv now (EspoCRM chooses when to fire). */
export const formatReminderIntro = (earliestDateStart: string, now = new Date()): string => {
  const today = formatKyivLocalIso(now).slice(0, 10);
  let start: MeetingStartKyiv;
  try {
    start = resolveMeetingStartInKyiv(earliestDateStart);
  } catch {
    return "Нагадування: у вас запланований візит.";
  }
  const { day: meetingDay, time, utcMs } = start;

  if (meetingDay === today) {
    const minutesUntil = Math.round((utcMs - now.getTime()) / 60_000);
    if (minutesUntil < 1) {
      return "Нагадування: незабаром у вас візит.";
    }
    if (minutesUntil < 60) {
      return `Нагадування: через ${minutesUntil} хв у вас візит.`;
    }
    if (minutesUntil < 120) {
      return "Нагадування: за годину у вас візит.";
    }
    return `Нагадування: сьогодні о ${time} у вас візит.`;
  }

  if (meetingDay === addCalendarDays(today, 1)) {
    return "Нагадування: завтра у вас запланований візит.";
  }

  return "Нагадування: у вас запланований візит.";
};

/** Ukrainian reminder body; intro adapts to lead time from earliest dateStart. */
export const formatReminderMessage = (
  meetings: ReminderPayload["meetings"],
  now = new Date(),
): string => {
  const today = formatKyivLocalIso(now).slice(0, 10);
  const sorted = [...meetings].sort((a, b) => {
    try {
      return resolveMeetingStartInKyiv(a.dateStart).utcMs - resolveMeetingStartInKyiv(b.dateStart).utcMs;
    } catch {
      return a.dateStart.localeCompare(b.dateStart);
    }
  });
  const earliest = sorted[0]!;
  const intro = formatReminderIntro(earliest.dateStart, now);
  const lines = sorted.map((meeting) => {
    let whenLabel: string;
    try {
      const { kyivWallIso } = resolveMeetingStartInKyiv(meeting.dateStart);
      whenLabel = formatKyivDateTimeLabel(kyivWallIso, today);
    } catch {
      whenLabel = formatKyivDateTimeLabel(meeting.dateStart, today);
    }
    return `🗓️ **${meeting.name}** — ${whenLabel}`;
  });
  return [intro, "", ...lines].join("\n");
};

/** Append Yes/No question when reminder HITL is required. */
export const formatReminderHitlMessage = (
  meetings: ReminderMeeting[],
  now = new Date(),
): string => `${formatReminderMessage(meetings, now)}\n\n${REMINDER_HITL_QUESTION}`;

const secretsEqual = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
};

const readBody = (req: IncomingMessage, maxBytes: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let oversized = false;
    req.on("data", (chunk: Buffer) => {
      if (oversized) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (oversized) {
        reject(new Error("body_too_large"));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });

const writeJson = (res: ServerResponse, status: number, body: Record<string, unknown>): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

export type ReminderWebhookHandlerOptions = {
  secret: string;
  sendMessage: ReminderSendMessage;
};

/** Request handler for tests and the HTTP server. */
export const createReminderWebhookHandler = (
  options: ReminderWebhookHandlerOptions,
): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
  const { secret, sendMessage } = options;

  return async (req, res) => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (method !== "POST" || path !== REMINDER_WEBHOOK_PATH) {
      writeJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    const provided = req.headers["x-webhook-secret"];
    const headerSecret = typeof provided === "string" ? provided : "";
    if (!secretsEqual(headerSecret, secret)) {
      writeJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readBody(req, MAX_REMINDER_BODY_BYTES);
    } catch {
      writeJson(res, 400, { ok: false, error: "invalid_body" });
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      writeJson(res, 400, { ok: false, error: "invalid_body" });
      return;
    }

    const parsed = reminderPayloadSchema.safeParse(parsedJson);
    if (!parsed.success) {
      writeJson(res, 400, { ok: false, error: "invalid_body" });
      return;
    }

    const hitlPending = reminderPendingFromHitlMeetings(parsed.data.meetings);
    if (hitlPending.length === 0) {
      const plannedWithoutId = parsed.data.meetings.filter((meeting) => {
        if (meeting.id?.trim()) {
          return false;
        }
        if (meeting.status === "Confirmed") {
          return false;
        }
        return meeting.status === undefined || meeting.status === "Planned";
      });
      if (plannedWithoutId.length > 0) {
        console.warn(
          `Reminder HITL skipped for telegramId=${parsed.data.telegramId}: Planned meeting(s) missing id (send id or meetingId).`,
        );
      }
    }
    const text = formatForTelegram(
      hitlPending.length > 0
        ? formatReminderHitlMessage(parsed.data.meetings)
        : formatReminderMessage(parsed.data.meetings),
    );
    try {
      await sendMessage(parsed.data.telegramId, text, {
        parse_mode: "HTML",
        reply_markup:
          hitlPending.length > 0 ? buildConfirmKeyboard() : buildDefaultMenuKeyboard(true),
      });
    } catch (error: unknown) {
      console.error("Reminder Telegram send failed:", error);
      writeJson(res, 502, { ok: false, error: "telegram_send_failed" });
      return;
    }

    if (hitlPending.length > 0) {
      setReminderConfirmPending(parsed.data.telegramId, hitlPending);
    }

    writeJson(res, 200, { ok: true, hitl: hitlPending.length > 0 });
  };
};

export type LaunchReminderWebhookOptions = {
  bot: Telegraf;
  secret: string;
  port: number;
};

export type ReminderWebhookHandle = {
  server: Server;
  close: () => Promise<void>;
};

export const launchReminderWebhook = (
  options: LaunchReminderWebhookOptions,
): Promise<ReminderWebhookHandle> => {
  const handler = createReminderWebhookHandler({
    secret: options.secret,
    sendMessage: (chatId, text, extra) => options.bot.telegram.sendMessage(chatId, text, extra),
  });

  const server = createServer((req, res) => {
    void handler(req, res);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => {
      server.off("error", reject);
      console.log(`Tomorrow-reminder webhook listening on port ${options.port}.`);
      resolve({
        server,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });
};
