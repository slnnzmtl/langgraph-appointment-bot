import {
  BOOKING_REPLACE_MENU,
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  MAIN_MENU_LABEL,
  VISIT_CHANGE_MENU,
} from "../../shared/clinic-constants.js";
import { asJsonRecord } from "../../shared/json-record.js";
import { runWithTelegramUserId } from "../../tools/telegram-user-context.js";
import {
  expectButtons,
  expectNoButtons,
  expectNotCalled,
  SmokeAssertError,
  soft,
} from "../assert.js";
import {
  allocateUnusedSmokePhone,
  getMeeting,
  listPlannedMeetingIds,
  preCleanTelegramContact,
} from "../crm.js";
import {
  writeTelegramId,
  SMOKE_CONTACT_NAME,
} from "../env.js";
import type { SoftWarning, SmokeScenario } from "../types.js";
import { installCallToolRecorder } from "../harness.js";
import {
  assertCreateMeetingOnce,
  assertMeetingPlanned,
  assertNoCreateMeeting,
  contactIdOrThrow,
  confirmOpenHitl,
  declineOpenHitl,
  driveUntilMutationConfirm,
  openBookingSession,
  prepareFreshContact,
  resolveCreatedMeetingId,
  runBookFlow,
} from "./booking-helpers.js";

const PRICE_HINT = /грн|\d/i;

export const bookNewContactScenario: SmokeScenario = {
  name: "book-new-contact",
  tier: "write",
  run: async (ctx) => {
    // Fresh telegram each run so create_contact must run after the slot.
    const telegramId = writeTelegramId("0");
    const phone = await allocateUnusedSmokePhone(ctx.callTool);
    await preCleanTelegramContact(ctx.callTool, telegramId);
    const bundle = openBookingSession(ctx, "book-new-contact", telegramId);
    try {
      const flow = await runBookFlow(bundle, {
        phone,
        decision: "confirm",
        ...SMOKE_CONTACT_NAME,
      });
      if (flow.sawContactBeforeSlot) {
        throw new SmokeAssertError(
          "book-new-contact: phone/contact asked before a slot was chosen",
        );
      }
      if (flow.createBeforeConfirm) {
        throw new SmokeAssertError(
          "book-new-contact: create_meeting MCP ran before ✅",
        );
      }
      assertCreateMeetingOnce("book-new-contact", flow.allCalls);
      if (!flow.allCalls.some((call) => call.name === "create_contact")) {
        throw new SmokeAssertError(
          "book-new-contact: expected create_contact after slot for a new telegram id",
        );
      }
      const contactId = await contactIdOrThrow(ctx, telegramId);
      ctx.cleanup.trackContact(contactId);
      const meetingId = await resolveCreatedMeetingId(ctx, contactId, flow.allCalls);
      await assertMeetingPlanned(ctx, meetingId, contactId);
      expectButtons("book-new-contact post-book menu", flow.last.buttons, [
        DEFAULT_MENU_HAS_VISITS[0],
        MAIN_MENU_LABEL,
      ]);
      console.log("✓ book-new-contact: meeting", meetingId);
      return { warnings: bundle.warnings, turns: bundle.session.turns };
    } finally {
      bundle.restore();
    }
  },
};

export const bookDeclineScenario: SmokeScenario = {
  name: "book-decline",
  tier: "write",
  run: async (ctx) => {
    const telegramId = writeTelegramId("1");
    const { contactId, phone } = await prepareFreshContact(ctx, telegramId);
    const before = await listPlannedMeetingIds(ctx.callTool, contactId);
    const bundle = openBookingSession(ctx, "book-decline", telegramId);
    try {
      const flow = await runBookFlow(bundle, {
        phone,
        decision: "decline",
        ...SMOKE_CONTACT_NAME,
      });
      assertNoCreateMeeting("book-decline", flow.allCalls);
      const after = await listPlannedMeetingIds(ctx.callTool, contactId);
      if (after.length !== before.length) {
        throw new SmokeAssertError(
          `book-decline: Planned meetings changed ${before.length} → ${after.length}`,
        );
      }
      expectButtons("book-decline menu", flow.last.buttons, [
        ...DEFAULT_MENU_NO_VISITS,
        MAIN_MENU_LABEL,
      ]);
      console.log("✓ book-decline: no create_meeting, DEFAULT MENU");
      return { warnings: bundle.warnings, turns: bundle.session.turns };
    } finally {
      bundle.restore();
    }
  },
};

export const pendingConfirmTextScenario: SmokeScenario = {
  name: "pending-confirm-text",
  tier: "write",
  run: async (ctx) => {
    const telegramId = writeTelegramId("2");
    const { contactId, phone } = await prepareFreshContact(ctx, telegramId);
    const bundle = openBookingSession(ctx, "pending-confirm-text", telegramId);
    try {
      await bundle.session.say("Записатись");
      await driveUntilMutationConfirm(bundle, { phone, ...SMOKE_CONTACT_NAME });

      const atConfirm = await bundle.session.snapshot();
      if (!atConfirm.pendingConfirm) {
        throw new SmokeAssertError(
          "pending-confirm-text: never reached HITL interrupt",
        );
      }

      // Resume consumes the LangGraph interrupt; mutation_confirm should stay.
      // A FAQ-like aside may replace the keyboard — still must not write.
      const side = await bundle.session.say("зачекайте секунду");
      expectNotCalled("pending-confirm-text side text", side.calls, [
        "create_meeting",
        "update_meeting",
      ]);

      if (!side.pendingConfirm) {
        soft(
          bundle.warnings,
          "pending-confirm-text: interrupt consumed by aside; re-picking a slot",
          false,
        );
        // Create chat-other invalidates the slot and does not re-arm HITL.
        // Agreement text is blocked while mutation_confirm is stale — pick again.
        await driveUntilMutationConfirm(bundle, { phone, ...SMOKE_CONTACT_NAME });
      }
      const confirmed = await confirmOpenHitl(bundle);
      assertCreateMeetingOnce("pending-confirm-text", confirmed.calls);
      await resolveCreatedMeetingId(ctx, contactId, confirmed.calls);
      console.log("✓ pending-confirm-text: aside wrote nothing, then ✅ booked");
      return { warnings: bundle.warnings, turns: bundle.session.turns };
    } finally {
      bundle.restore();
    }
  },
};

export const doubleBookGuardScenario: SmokeScenario = {
  name: "double-book-guard",
  tier: "write",
  run: async (ctx) => {
    const telegramId = writeTelegramId("3");
    const { contactId, phone } = await prepareFreshContact(ctx, telegramId);
    const bundle = openBookingSession(ctx, "double-book-guard", telegramId);
    try {
      const first = await runBookFlow(bundle, {
        phone,
        decision: "confirm",
        ...SMOKE_CONTACT_NAME,
      });
      assertCreateMeetingOnce("double-book-guard first", first.allCalls);
      await resolveCreatedMeetingId(ctx, contactId, first.allCalls);
      const afterFirst = await listPlannedMeetingIds(ctx.callTool, contactId);
      if (afterFirst.length !== 1) {
        throw new SmokeAssertError(
          `double-book-guard: first book expected 1 Planned meeting, got ${afterFirst.length}`,
        );
      }

      const second = await bundle.session.say("Записатись");
      // Do not autopilot ✅ — that can confirm REPLACE cancel and wipe the visit.
      if (second.state.pendingInteraction?.kind === "service_confirm") {
        await bundle.session.tap("Так");
      }

      const planned = await listPlannedMeetingIds(ctx.callTool, contactId);
      if (planned.length !== 1) {
        throw new SmokeAssertError(
          `double-book-guard: expected exactly 1 Planned meeting, got ${planned.length}`,
        );
      }
      const snap = await bundle.session.snapshot();
      if (snap.state.pendingInteraction?.kind === "visit_select"
        && snap.state.pendingInteraction.stage === "replacement") {
        expectButtons("double-book-guard REPLACE", snap.buttons, [...BOOKING_REPLACE_MENU]);
        expectNoButtons("double-book-guard REPLACE", snap.buttons, ["Перенести"]);
      }
      if (second.buttons.includes("Скасувати") && second.buttons.includes("Ні, дякую")) {
        expectNoButtons("double-book-guard second", second.buttons, ["Перенести"]);
      }
      console.log("✓ double-book-guard: still one Planned meeting");
      return { warnings: bundle.warnings, turns: bundle.session.turns };
    } finally {
      bundle.restore();
    }
  },
};

export const rescheduleScenario: SmokeScenario = {
  name: "reschedule",
  tier: "write",
  run: async (ctx) => {
    const telegramId = writeTelegramId("4");
    const { contactId, phone } = await prepareFreshContact(ctx, telegramId);
    const bundle = openBookingSession(ctx, "reschedule", telegramId);
    try {
      const booked = await runBookFlow(bundle, {
        phone,
        decision: "confirm",
        ...SMOKE_CONTACT_NAME,
      });
      const meetingId = await resolveCreatedMeetingId(ctx, contactId, booked.allCalls);
      const before = await assertMeetingPlanned(ctx, meetingId, contactId);
      const oldStart = String(before.dateStart);

      const myVisit = await bundle.session.say("Мій запис");
      expectButtons("reschedule visit menu", myVisit.buttons, [...VISIT_CHANGE_MENU]);

      await bundle.session.tap("Перенести");
      const moved = await bundle.session.autopilotBooking({
        phone,
        ...SMOKE_CONTACT_NAME,
        decision: "confirm",
        maxTurns: 12,
      });
      const updates = moved.turns
        .flatMap((turn) => turn.calls)
        .filter((call) => call.name === "update_meeting");
      if (updates.length === 0) {
        throw new SmokeAssertError("reschedule: expected update_meeting MCP call");
      }
      const after = await getMeeting(ctx.callTool, meetingId);
      const newStart = String(after.dateStart);
      if (newStart === oldStart) {
        throw new SmokeAssertError(
          `reschedule: dateStart unchanged (${oldStart})`,
        );
      }
      console.log("✓ reschedule:", oldStart, "→", newStart);
      return { warnings: bundle.warnings, turns: bundle.session.turns };
    } finally {
      bundle.restore();
    }
  },
};

export const cancelScenario: SmokeScenario = {
  name: "cancel",
  tier: "write",
  run: async (ctx) => {
    const telegramId = writeTelegramId("5");
    const { contactId, phone } = await prepareFreshContact(ctx, telegramId);
    const bundle = openBookingSession(ctx, "cancel", telegramId);
    try {
      const booked = await runBookFlow(bundle, {
        phone,
        decision: "confirm",
        ...SMOKE_CONTACT_NAME,
      });
      const meetingId = await resolveCreatedMeetingId(ctx, contactId, booked.allCalls);

      const myVisit = await bundle.session.say("Мій запис");
      expectButtons("cancel visit menu", myVisit.buttons, [...VISIT_CHANGE_MENU]);
      await bundle.session.tap("Скасувати");
      const cancelled = await bundle.session.autopilotBooking({
        phone,
        ...SMOKE_CONTACT_NAME,
        decision: "confirm",
        maxTurns: 6,
      });
      const statusUpdates = cancelled.turns
        .flatMap((turn) => turn.calls)
        .filter(
          (call) =>
            call.name === "update_meeting"
            && (call.args as { status?: string }).status === "Not Held",
        );
      if (statusUpdates.length === 0) {
        soft(bundle.warnings, "cancel: no update_meeting Not Held in recorder", false);
      }
      const meeting = await getMeeting(ctx.callTool, meetingId);
      if (meeting.status !== "Not Held") {
        throw new SmokeAssertError(
          `cancel: expected Not Held, got ${String(meeting.status)}`,
        );
      }
      expectButtons("cancel post menu", cancelled.last.buttons, [
        DEFAULT_MENU_NO_VISITS[0],
        MAIN_MENU_LABEL,
      ]);
      console.log("✓ cancel: meeting Not Held");
      return { warnings: bundle.warnings, turns: bundle.session.turns };
    } finally {
      bundle.restore();
    }
  },
};

export const cancelHitlFaqScenario: SmokeScenario = {
  name: "cancel-hitl-faq",
  tier: "write",
  run: async (ctx) => {
    const telegramId = writeTelegramId("a");
    const { contactId, phone } = await prepareFreshContact(ctx, telegramId);
    const bundle = openBookingSession(ctx, "cancel-hitl-faq", telegramId);
    try {
      const booked = await runBookFlow(bundle, {
        phone,
        decision: "confirm",
        ...SMOKE_CONTACT_NAME,
      });
      const meetingId = await resolveCreatedMeetingId(ctx, contactId, booked.allCalls);

      const myVisit = await bundle.session.say("Мій запис");
      expectButtons("cancel-hitl-faq visit menu", myVisit.buttons, [...VISIT_CHANGE_MENU]);
      const cancelTap = await bundle.session.tap("Скасувати");
      // Single-visit cancel usually opens HITL on this tap; do not autopilot ✅ yet.
      if (!cancelTap.pendingConfirm) {
        await driveUntilMutationConfirm(bundle, {
          phone,
          ...SMOKE_CONTACT_NAME,
          maxTurns: 6,
        });
      }
      const atCancel = await bundle.session.snapshot();
      if (!atCancel.pendingConfirm) {
        throw new SmokeAssertError("cancel-hitl-faq: never reached cancel HITL interrupt");
      }

      const faq = await bundle.session.say("Скільки коштує консультація?");
      expectNotCalled("cancel-hitl-faq price aside", faq.calls, "update_meeting");
      expectButtons("cancel-hitl-faq after FAQ", faq.buttons, [
        CONFIRM_YES_LABEL,
        CONFIRM_NO_LABEL,
      ]);
      soft(
        bundle.warnings,
        "cancel-hitl-faq reply missing price-like text",
        PRICE_HINT.test(faq.reply),
        faq.reply.slice(0, 200),
      );
      const still = await getMeeting(ctx.callTool, meetingId);
      if (still.status !== "Planned" && still.status !== "Confirmed") {
        throw new SmokeAssertError(
          `cancel-hitl-faq: expected Planned/Confirmed after FAQ, got ${String(still.status)}`,
        );
      }

      await declineOpenHitl(bundle);
      console.log("✓ cancel-hitl-faq: price aside re-showed cancel ✅/❌, then ❌ kept visit");
      return { warnings: bundle.warnings, turns: bundle.session.turns };
    } finally {
      bundle.restore();
    }
  },
};

export const hitlTypedScenario: SmokeScenario = {
  name: "hitl-typed",
  tier: "write",
  run: async (ctx) => {
    const confirmId = writeTelegramId("b");
    const declineId = writeTelegramId("c");
    const confirmPhone = await allocateUnusedSmokePhone(ctx.callTool);
    await preCleanTelegramContact(ctx.callTool, confirmId);

    const confirmBundle = openBookingSession(ctx, "hitl-typed-confirm", confirmId);
    try {
      await confirmBundle.session.say("Записатись");
      await driveUntilMutationConfirm(confirmBundle, {
        phone: confirmPhone,
        ...SMOKE_CONTACT_NAME,
      });
      const atConfirm = await confirmBundle.session.snapshot();
      if (!atConfirm.pendingConfirm) {
        throw new SmokeAssertError("hitl-typed: never reached create HITL for typed affirm");
      }
      const affirmed = await confirmBundle.session.say("Так, підтверджую");
      assertCreateMeetingOnce("hitl-typed affirm", affirmed.calls);
      const contactId = await contactIdOrThrow(ctx, confirmId);
      ctx.cleanup.trackContact(contactId);
      await resolveCreatedMeetingId(ctx, contactId, affirmed.calls);
      console.log("✓ hitl-typed: typed affirm created meeting");
    } finally {
      confirmBundle.restore();
    }

    const { contactId: declineContactId, phone: declinePhone } = await prepareFreshContact(
      ctx,
      declineId,
    );
    const before = await listPlannedMeetingIds(ctx.callTool, declineContactId);
    const declineBundle = openBookingSession(ctx, "hitl-typed-decline", declineId);
    try {
      await declineBundle.session.say("Записатись");
      await driveUntilMutationConfirm(declineBundle, {
        phone: declinePhone,
        ...SMOKE_CONTACT_NAME,
      });
      const atDecline = await declineBundle.session.snapshot();
      if (!atDecline.pendingConfirm) {
        throw new SmokeAssertError("hitl-typed: never reached create HITL for typed decline");
      }
      const declined = await declineBundle.session.say("ні");
      assertNoCreateMeeting("hitl-typed decline", declined.calls);
      const after = await listPlannedMeetingIds(ctx.callTool, declineContactId);
      if (after.length !== before.length) {
        throw new SmokeAssertError(
          `hitl-typed: Planned meetings changed ${before.length} → ${after.length} after typed ні`,
        );
      }
      console.log("✓ hitl-typed: typed ні wrote nothing");
      return {
        warnings: [...confirmBundle.warnings, ...declineBundle.warnings],
        turns: confirmBundle.session.turns + declineBundle.session.turns,
      };
    } finally {
      declineBundle.restore();
    }
  },
};

export const ownershipScenario: SmokeScenario = {
  name: "ownership",
  tier: "write",
  run: async (ctx) => {
    const ownerId = writeTelegramId("6");
    const otherId = writeTelegramId("9");
    const { contactId, phone } = await prepareFreshContact(ctx, ownerId);

    const bundle = openBookingSession(ctx, "ownership", ownerId);
    let meetingId: string;
    try {
      const booked = await runBookFlow(bundle, {
        phone,
        decision: "confirm",
        ...SMOKE_CONTACT_NAME,
      });
      meetingId = await resolveCreatedMeetingId(ctx, contactId, booked.allCalls);
    } finally {
      bundle.restore();
    }

    const cancelTool = ctx.runtime
      .getBootstrap()
      .agentTools.booking
      ?.find((tool) => tool.name === "cancel_meeting");
    if (!cancelTool) {
      throw new SmokeAssertError("ownership: cancel_meeting tool missing");
    }

    const recorder = installCallToolRecorder(ctx.runtime.getBootstrap().adapters);
    try {
      const raw = await runWithTelegramUserId(otherId, () =>
        cancelTool.invoke({
          meetingId,
          confirmMessage: "Скасувати візит?",
        }),
      );
      const record = asJsonRecord(raw) ?? asJsonRecord(String(raw));
      if (record?.error !== "Not authorized") {
        throw new SmokeAssertError(
          `ownership: expected Not authorized, got ${JSON.stringify(record ?? raw).slice(0, 300)}`,
        );
      }
      expectNotCalled("ownership", recorder.calls, "update_meeting");
      const still = await getMeeting(ctx.callTool, meetingId);
      if (still.status === "Not Held") {
        throw new SmokeAssertError("ownership: meeting was cancelled by other user");
      }
      console.log("✓ ownership: cancel_meeting refused for other telegram id");
    } finally {
      recorder.restore();
    }
    return { warnings: [] as SoftWarning[] };
  },
};

export { contactIdOrThrow };
