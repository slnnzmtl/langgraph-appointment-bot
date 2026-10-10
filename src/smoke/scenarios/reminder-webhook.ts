import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  applyReminderDecision,
  createReminderWebhookHandler,
  REMINDER_WEBHOOK_PATH,
  type ReminderSendMessage,
} from "../../adapter/reminder-webhook.js";
import {
  CLINIC_SLOT_MINUTES,
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  CONSULTATION_SERVICE_ID,
  DEFAULT_MENU_HAS_VISITS,
} from "../../shared/clinic-constants.js";
import { asJsonRecord } from "../../shared/json-record.js";
import type { McpCallTool } from "../../shared/mcp.js";
import {
  addCalendarDays,
  extractMeetingsFromSearchResult,
  fallbackClinicTimeRanges,
  findNextAvailableSlots,
  getKyivWeekdayIndex,
  kyivToday,
  localIso,
} from "../../tools/availability-slots.js";
import { SmokeAssertError } from "../assert.js";
import {
  allocateUnusedSmokePhone,
  ensureSmokeContact,
  getMeeting,
  preCleanTelegramContact,
} from "../crm.js";
import {
  SMOKE_CONTACT_NAME,
  SMOKE_MEETING_NAME_PREFIX,
  writeTelegramId,
} from "../env.js";
import type { SmokeScenario } from "../types.js";

const SEED_HORIZON_DAYS = 14;
const CREATE_RETRY_MAX = 4;

const slotFromStart = (dateStart: string): { dateStart: string; dateEnd: string } => {
  const [day, time] = dateStart.split("T");
  const [hour, minute] = (time ?? "11:00:00").split(":").map(Number);
  const endMinute = (minute ?? 0) + CLINIC_SLOT_MINUTES;
  const endHour = (hour ?? 11) + Math.floor(endMinute / 60);
  return {
    dateStart,
    dateEnd: localIso(day ?? kyivToday(), endHour, endMinute % 60),
  };
};

const isBusySlotError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /overlap|outside working hours|already booked|busy/i.test(message);
};

const isRateLimitError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /too many requests|rate.?limit|429/i.test(message);
};

const withRateLimitRetry = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < CREATE_RETRY_MAX; attempt += 1) {
    try {
      return await run();
    } catch (error: unknown) {
      lastError = error;
      if (!isRateLimitError(error) || attempt === CREATE_RETRY_MAX - 1) {
        throw error;
      }
      await delay(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label}: rate-limit retries exhausted`);
};

/** One search_meetings, then create on computed free slots (not a write-scan of the calendar). */
const seedOnFreeSlot = async (
  callTool: McpCallTool,
  contactId: string,
  assignedUserId: string,
  name: string,
  occupiedStarts: Set<string>,
): Promise<{ meetingId: string; slot: { dateStart: string; dateEnd: string } }> => {
  const startDate = addCalendarDays(kyivToday(), 2);
  const dateTo = addCalendarDays(startDate, SEED_HORIZON_DAYS - 1);
  const raw = await callTool("search_meetings", {
    dateFrom: startDate,
    dateTo,
    assignedUserId,
    limit: 200,
  });
  const meetings = extractMeetingsFromSearchResult(raw);
  const found = findNextAvailableSlots({
    startDate,
    meetings,
    resolveTimeRanges: (day) => {
      const weekday = getKyivWeekdayIndex(day);
      if (weekday === "0" || weekday === "6") {
        return [];
      }
      return fallbackClinicTimeRanges();
    },
    maxDays: SEED_HORIZON_DAYS,
    maxDaysWithSlots: SEED_HORIZON_DAYS,
    durationMinutes: CLINIC_SLOT_MINUTES,
    omitDateStarts: [...occupiedStarts],
  });

  const candidates = found.days.flatMap((day) => day.slots);
  if (candidates.length === 0) {
    throw new SmokeAssertError(
      "reminder-webhook: no free weekday slot on the assigned user calendar",
    );
  }

  let lastBusy: unknown;
  for (const candidate of candidates) {
    if (occupiedStarts.has(candidate.dateStart)) {
      continue;
    }
    const slot = slotFromStart(candidate.dateStart);
    try {
      const meetingId = await withRateLimitRetry("create_meeting", () =>
        seedMeeting(callTool, contactId, assignedUserId, name, slot),
      );
      return { meetingId, slot };
    } catch (error: unknown) {
      if (isBusySlotError(error)) {
        lastBusy = error;
        occupiedStarts.add(slot.dateStart);
        continue;
      }
      throw error;
    }
  }
  throw new SmokeAssertError(
    `reminder-webhook: computed free slots rejected by create_meeting${
      lastBusy instanceof Error ? `: ${lastBusy.message}` : ""
    }`,
  );
};

const seedMeeting = async (
  callTool: McpCallTool,
  contactId: string,
  assignedUserId: string,
  name: string,
  slot: { dateStart: string; dateEnd: string },
): Promise<string> => {
  const created = await callTool("create_meeting", {
    name,
    dateStart: slot.dateStart,
    dateEnd: slot.dateEnd,
    assignedUserId,
    parentType: "Contact",
    parentId: contactId,
    contactsIds: [contactId],
    // EspoCRM requires cServicesMulti; MCP accepts cServicesIds (same as booking tool).
    cServicesIds: [CONSULTATION_SERVICE_ID],
    cServicesMultiIds: [CONSULTATION_SERVICE_ID],
    status: "Planned",
  });
  const record = asJsonRecord(created);
  const id =
    (typeof record?.id === "string" && record.id)
    || (typeof record?.meetingId === "string" && record.meetingId)
    || null;
  if (!id) {
    const blob = JSON.stringify(created);
    if (isBusySlotError(blob)) {
      throw new Error(blob);
    }
    if (isRateLimitError(blob)) {
      throw new Error(blob);
    }
    throw new SmokeAssertError(
      `reminder-webhook: create_meeting returned no id: ${blob.slice(0, 200)}`,
    );
  }
  return id;
};

export const reminderWebhookScenario: SmokeScenario = {
  name: "reminder-webhook",
  tier: "write",
  run: async (ctx) => {
    const telegramId = writeTelegramId("7");
    const phone = await allocateUnusedSmokePhone(ctx.callTool);
    await preCleanTelegramContact(ctx.callTool, telegramId);
    const contact = await ensureSmokeContact(ctx.callTool, telegramId, {
      firstName: SMOKE_CONTACT_NAME.firstName,
      lastName: SMOKE_CONTACT_NAME.lastName,
      phoneNumber: phone,
    });
    ctx.cleanup.trackContact(contact.id);
    await preCleanTelegramContact(ctx.callTool, telegramId);

    const assignedUserId = ctx.runtime.getBootstrap().config.assignedUserId;
    const occupiedStarts = new Set<string>();
    const seededConfirm = await seedOnFreeSlot(
      ctx.callTool,
      contact.id,
      assignedUserId,
      `${SMOKE_MEETING_NAME_PREFIX} reminder confirm`,
      occupiedStarts,
    );
    ctx.cleanup.trackMeeting(seededConfirm.meetingId);
    occupiedStarts.add(seededConfirm.slot.dateStart);
    const seededDecline = await seedOnFreeSlot(
      ctx.callTool,
      contact.id,
      assignedUserId,
      `${SMOKE_MEETING_NAME_PREFIX} reminder decline`,
      occupiedStarts,
    );
    ctx.cleanup.trackMeeting(seededDecline.meetingId);
    const meetingConfirm = seededConfirm.meetingId;
    const meetingDecline = seededDecline.meetingId;
    const confirmSlot = seededConfirm.slot;
    const declineSlot = seededDecline.slot;

    const secret = `smoke-${randomUUID()}`;
    const sent: Array<{
      chatId: string;
      text: string;
      reply_markup: unknown;
    }> = [];
    const sendMessage: ReminderSendMessage = async (chatId, text, extra) => {
      sent.push({ chatId, text, reply_markup: extra.reply_markup });
      return {};
    };

    const handler = createReminderWebhookHandler({ secret, sendMessage });
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
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const unauthorized = await fetch(`${baseUrl}${REMINDER_WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": "wrong",
        },
        body: JSON.stringify({
          telegramId,
          meetings: [
            {
              id: meetingConfirm,
              name: `${SMOKE_MEETING_NAME_PREFIX} reminder confirm`,
              dateStart: confirmSlot.dateStart,
              status: "Planned",
            },
          ],
        }),
      });
      if (unauthorized.status !== 401) {
        throw new SmokeAssertError(
          `reminder-webhook: expected 401 for bad secret, got ${unauthorized.status}`,
        );
      }

      const ok = await fetch(`${baseUrl}${REMINDER_WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": secret,
        },
        body: JSON.stringify({
          telegramId,
          meetings: [
            {
              id: meetingConfirm,
              name: `${SMOKE_MEETING_NAME_PREFIX} reminder confirm`,
              dateStart: confirmSlot.dateStart,
              status: "Planned",
            },
          ],
        }),
      });
      const okBody = (await ok.json()) as { ok?: boolean; hitl?: boolean };
      if (!ok.ok || okBody.ok !== true || okBody.hitl !== true) {
        throw new SmokeAssertError(
          `reminder-webhook: expected {ok:true,hitl:true}, got ${ok.status} ${JSON.stringify(okBody)}`,
        );
      }
      if (sent.length === 0) {
        throw new SmokeAssertError("reminder-webhook: sendMessage not called");
      }
      const markup = sent[0]?.reply_markup as { keyboard?: Array<Array<{ text?: string }>> };
      const labels =
        markup?.keyboard?.flat().map((button) => button.text ?? "") ?? [];
      if (!labels.includes(CONFIRM_YES_LABEL) || !labels.includes(CONFIRM_NO_LABEL)) {
        throw new SmokeAssertError(
          `reminder-webhook: expected ✅/❌ keyboard, got [${labels.join("|")}]`,
        );
      }

      const approved = await applyReminderDecision(
        ctx.callTool,
        telegramId,
        CONFIRM_YES_LABEL,
      );
      if (approved.kind !== "updated" || approved.status !== "Confirmed") {
        throw new SmokeAssertError(
          `reminder-webhook: ✅ apply failed: ${JSON.stringify(approved)}`,
        );
      }
      const confirmed = await getMeeting(ctx.callTool, meetingConfirm);
      if (confirmed.status !== "Confirmed") {
        throw new SmokeAssertError(
          `reminder-webhook: expected Confirmed, got ${String(confirmed.status)}`,
        );
      }

      sent.length = 0;
      const ok2 = await fetch(`${baseUrl}${REMINDER_WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": secret,
        },
        body: JSON.stringify({
          telegramId,
          meetings: [
            {
              id: meetingDecline,
              name: `${SMOKE_MEETING_NAME_PREFIX} reminder decline`,
              dateStart: declineSlot.dateStart,
              status: "Planned",
            },
          ],
        }),
      });
      const ok2Body = (await ok2.json()) as { ok?: boolean; hitl?: boolean };
      if (!ok2.ok || ok2Body.hitl !== true) {
        throw new SmokeAssertError(
          `reminder-webhook: second POST failed: ${JSON.stringify(ok2Body)}`,
        );
      }
      const declined = await applyReminderDecision(
        ctx.callTool,
        telegramId,
        CONFIRM_NO_LABEL,
      );
      if (declined.kind !== "updated" || declined.status !== "Not Held") {
        throw new SmokeAssertError(
          `reminder-webhook: ❌ apply failed: ${JSON.stringify(declined)}`,
        );
      }
      const notHeld = await getMeeting(ctx.callTool, meetingDecline);
      if (notHeld.status !== "Not Held") {
        throw new SmokeAssertError(
          `reminder-webhook: expected Not Held, got ${String(notHeld.status)}`,
        );
      }

      sent.length = 0;
      const confirmedNotify = await fetch(`${baseUrl}${REMINDER_WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": secret,
        },
        body: JSON.stringify({
          telegramId,
          meetings: [
            {
              id: meetingConfirm,
              name: `${SMOKE_MEETING_NAME_PREFIX} reminder confirm`,
              dateStart: confirmSlot.dateStart,
              status: "Confirmed",
            },
          ],
        }),
      });
      const confirmedNotifyBody = (await confirmedNotify.json()) as {
        ok?: boolean;
        hitl?: boolean;
      };
      if (
        !confirmedNotify.ok
        || confirmedNotifyBody.ok !== true
        || confirmedNotifyBody.hitl !== false
      ) {
        throw new SmokeAssertError(
          `reminder-webhook: Confirmed notify expected {ok:true,hitl:false}, got ${confirmedNotify.status} ${JSON.stringify(confirmedNotifyBody)}`,
        );
      }
      const confirmedLabels =
        (
          sent[0]?.reply_markup as { keyboard?: Array<Array<{ text?: string }>> } | undefined
        )?.keyboard?.flat().map((button) => button.text ?? "") ?? [];
      if (
        confirmedLabels.includes(CONFIRM_YES_LABEL)
        || confirmedLabels.includes(CONFIRM_NO_LABEL)
      ) {
        throw new SmokeAssertError(
          `reminder-webhook: Confirmed notify must not show ✅/❌, got [${confirmedLabels.join("|")}]`,
        );
      }
      if (!confirmedLabels.includes(DEFAULT_MENU_HAS_VISITS[0])) {
        throw new SmokeAssertError(
          `reminder-webhook: Confirmed notify missing ${DEFAULT_MENU_HAS_VISITS[0]}, got [${confirmedLabels.join("|")}]`,
        );
      }
      const staleConfirm = await applyReminderDecision(
        ctx.callTool,
        telegramId,
        CONFIRM_YES_LABEL,
      );
      if (staleConfirm.kind !== "none") {
        throw new SmokeAssertError(
          `reminder-webhook: expected none after Confirmed notify, got ${JSON.stringify(staleConfirm)}`,
        );
      }
      const stillConfirmed = await getMeeting(ctx.callTool, meetingConfirm);
      if (stillConfirmed.status !== "Confirmed") {
        throw new SmokeAssertError(
          `reminder-webhook: Confirmed status changed after notify-only, got ${String(stillConfirmed.status)}`,
        );
      }

      sent.length = 0;
      const missingId = await fetch(`${baseUrl}${REMINDER_WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Secret": secret,
        },
        body: JSON.stringify({
          telegramId,
          meetings: [
            {
              name: `${SMOKE_MEETING_NAME_PREFIX} reminder no-id`,
              dateStart: confirmSlot.dateStart,
              status: "Planned",
            },
          ],
        }),
      });
      const missingIdBody = (await missingId.json()) as {
        ok?: boolean;
        hitl?: boolean;
      };
      if (!missingId.ok || missingIdBody.ok !== true || missingIdBody.hitl !== false) {
        throw new SmokeAssertError(
          `reminder-webhook: missing id expected {ok:true,hitl:false}, got ${missingId.status} ${JSON.stringify(missingIdBody)}`,
        );
      }
      const missingLabels =
        (
          sent[0]?.reply_markup as { keyboard?: Array<Array<{ text?: string }>> } | undefined
        )?.keyboard?.flat().map((button) => button.text ?? "") ?? [];
      if (
        missingLabels.includes(CONFIRM_YES_LABEL)
        || missingLabels.includes(CONFIRM_NO_LABEL)
      ) {
        throw new SmokeAssertError(
          `reminder-webhook: missing-id notify must not show ✅/❌, got [${missingLabels.join("|")}]`,
        );
      }
      const missingDecision = await applyReminderDecision(
        ctx.callTool,
        telegramId,
        CONFIRM_YES_LABEL,
      );
      if (missingDecision.kind !== "none") {
        throw new SmokeAssertError(
          `reminder-webhook: expected none after missing-id notify, got ${JSON.stringify(missingDecision)}`,
        );
      }
      console.log(
        "✓ reminder-webhook: 401, HITL ✅/❌, Confirmed notify-only, missing-id notify-only",
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
};
