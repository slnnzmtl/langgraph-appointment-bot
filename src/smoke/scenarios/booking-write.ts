import {
  BOOKING_OFFER_MENU,
  BOOKING_REPLACE_MENU,
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  CONSULTATION_SERVICE_ID,
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  MAIN_MENU_LABEL,
  VISIT_CHANGE_MENU,
} from "../../shared/clinic-constants.js";
import { asJsonRecord } from "../../shared/json-record.js";
import { normalizeLocalIsoDatetime } from "../../tools/availability-slots.js";
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
  findContactByTelegram,
  getMeeting,
  getMeetingServiceIds,
  listPlannedMeetingIds,
  preCleanTelegramContact,
  seedPhoneOnlyContact,
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
import { drillToProcedureOffer, openBookingOffer } from "./offer-helpers.js";

const PRICE_HINT = /грн|\d/i;
const VISIT_NOTE_TEXT = "Турбує сухість шкіри на обличчі";

const hhmmFromLocalIso = (dateStart: string): string | null => {
  const match = /T(\d{2}:\d{2})/.exec(dateStart);
  return match?.[1] ?? null;
};

const dayFromLocalIso = (dateStart: string): string | null => {
  const day = dateStart.split("T")[0];
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
};

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
        noteText: VISIT_NOTE_TEXT,
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
      const noteAnswered = flow.turns.some(
        (turn) => turn.state.bookingDraft?.note.status === "answered",
      );
      if (!noteAnswered) {
        throw new SmokeAssertError(
          "book-new-contact: expected bookingDraft.note.status=answered after typed visit note",
        );
      }
      const createCall = flow.allCalls.find((call) => call.name === "create_meeting");
      const descriptionArg = createCall?.args.description;
      if (typeof descriptionArg !== "string" || !descriptionArg.trim()) {
        throw new SmokeAssertError(
          "book-new-contact: create_meeting args missing non-empty description",
        );
      }
      soft(
        bundle.warnings,
        "book-new-contact description missing сух hint",
        /сух/i.test(descriptionArg),
        descriptionArg.slice(0, 200),
      );
      const contactId = await contactIdOrThrow(ctx, telegramId);
      ctx.cleanup.trackContact(contactId);
      const meetingId = await resolveCreatedMeetingId(ctx, contactId, flow.allCalls);
      await assertMeetingPlanned(ctx, meetingId, contactId);
      const meeting = await getMeeting(ctx.callTool, meetingId);
      const storedDescription = meeting.description;
      if (typeof storedDescription !== "string" || !storedDescription.trim()) {
        throw new SmokeAssertError(
          `book-new-contact: meeting ${meetingId} description empty`,
        );
      }
      expectButtons("book-new-contact post-book menu", flow.last.buttons, [
        DEFAULT_MENU_HAS_VISITS[0],
        MAIN_MENU_LABEL,
      ]);
      console.log("✓ book-new-contact: meeting", meetingId, "with visit note");
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

      await bundle.session.say("Записатись");
      await driveUntilMutationConfirm(bundle, {
        phone,
        ...SMOKE_CONTACT_NAME,
        expectAction: "create",
      });
      const leave = await bundle.session.say(MAIN_MENU_LABEL);
      assertNoCreateMeeting("book-decline main-menu", leave.calls);
      if (leave.pendingConfirm) {
        throw new SmokeAssertError(
          "book-decline: pendingConfirm still open after Головне меню",
        );
      }
      const afterLeave = await listPlannedMeetingIds(ctx.callTool, contactId);
      if (afterLeave.length !== before.length) {
        throw new SmokeAssertError(
          `book-decline: Planned meetings changed after Головне меню ${before.length} → ${afterLeave.length}`,
        );
      }
      expectButtons("book-decline after main menu", leave.buttons, [
        ...DEFAULT_MENU_NO_VISITS,
        MAIN_MENU_LABEL,
      ]);
      console.log("✓ book-decline: ❌ and Головне меню wrote nothing");
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
      if (
        second.state.pendingInteraction?.kind !== "visit_select"
        || second.state.pendingInteraction.stage !== "replacement"
      ) {
        throw new SmokeAssertError(
          `double-book-guard: expected visit_select/replacement after Записатись, got ${second.state.pendingInteraction?.kind ?? "null"}/${second.state.pendingInteraction?.kind === "visit_select" ? second.state.pendingInteraction.stage : "n/a"}`,
        );
      }
      expectButtons("double-book-guard REPLACE", second.buttons, [...BOOKING_REPLACE_MENU]);
      expectNoButtons("double-book-guard REPLACE", second.buttons, ["Перенести"]);
      assertNoCreateMeeting("double-book-guard REPLACE turn", second.calls);

      await bundle.session.tap("Ні, дякую");
      const planned = await listPlannedMeetingIds(ctx.callTool, contactId);
      if (planned.length !== 1) {
        throw new SmokeAssertError(
          `double-book-guard: expected exactly 1 Planned meeting after decline, got ${planned.length}`,
        );
      }
      console.log("✓ double-book-guard: REPLACE then decline, still one Planned meeting");
      return { warnings: bundle.warnings, turns: bundle.session.turns };
    } finally {
      bundle.restore();
    }
  },
};

export const replaceRebookScenario: SmokeScenario = {
  name: "replace-rebook",
  tier: "write",
  run: async (ctx) => {
    const telegramId = writeTelegramId("d");
    const { contactId, phone } = await prepareFreshContact(ctx, telegramId);
    const bundle = openBookingSession(ctx, "replace-rebook", telegramId);
    try {
      const first = await runBookFlow(bundle, {
        phone,
        decision: "confirm",
        ...SMOKE_CONTACT_NAME,
      });
      const oldId = await resolveCreatedMeetingId(ctx, contactId, first.allCalls);

      const replaceTurn = await bundle.session.say("Записатись");
      if (
        replaceTurn.state.pendingInteraction?.kind !== "visit_select"
        || replaceTurn.state.pendingInteraction.stage !== "replacement"
      ) {
        throw new SmokeAssertError(
          `replace-rebook: expected visit_select/replacement after Записатись, got ${replaceTurn.state.pendingInteraction?.kind ?? "null"}/${replaceTurn.state.pendingInteraction?.kind === "visit_select" ? replaceTurn.state.pendingInteraction.stage : "n/a"}`,
        );
      }
      expectButtons("replace-rebook REPLACE", replaceTurn.buttons, [...BOOKING_REPLACE_MENU]);
      expectNoButtons("replace-rebook REPLACE", replaceTurn.buttons, ["Перенести"]);
      assertNoCreateMeeting("replace-rebook REPLACE turn", replaceTurn.calls);

      const cancelTap = await bundle.session.tap("Скасувати");
      if (!cancelTap.pendingConfirm) {
        await driveUntilMutationConfirm(bundle, {
          phone,
          ...SMOKE_CONTACT_NAME,
          expectAction: "cancel",
          maxTurns: 6,
        });
      }
      const atCancel = await bundle.session.snapshot();
      if (
        atCancel.state.pendingInteraction?.kind !== "mutation_confirm"
        || atCancel.state.pendingInteraction.action !== "cancel"
      ) {
        throw new SmokeAssertError(
          `replace-rebook: expected cancel HITL for ${oldId}, got ${atCancel.state.pendingInteraction?.kind ?? "null"}`,
        );
      }
      const cancelConfirmed = await confirmOpenHitl(bundle);
      const oldAfterCancel = await getMeeting(ctx.callTool, oldId);
      if (oldAfterCancel.status !== "Not Held") {
        throw new SmokeAssertError(
          `replace-rebook: expected old meeting Not Held, got ${String(oldAfterCancel.status)}`,
        );
      }

      const driveCreate = await driveUntilMutationConfirm(bundle, {
        phone,
        ...SMOKE_CONTACT_NAME,
        expectAction: "create",
        maxTurns: 14,
      });
      const selectedSlot = (await bundle.session.snapshot()).state.bookingDraft?.selectedSlot;
      if (selectedSlot?.dateStart == null) {
        throw new SmokeAssertError("replace-rebook: missing selectedSlot.dateStart before create");
      }
      const created = await confirmOpenHitl(bundle);
      const allPostReplace = [
        ...cancelTap.calls,
        ...cancelConfirmed.calls,
        ...driveCreate.flatMap((turn) => turn.calls),
        ...created.calls,
      ];
      assertCreateMeetingOnce("replace-rebook create", allPostReplace);

      const newId = await resolveCreatedMeetingId(ctx, contactId, allPostReplace);
      if (newId === oldId) {
        throw new SmokeAssertError(
          `replace-rebook: expected a new meeting id, got same ${oldId}`,
        );
      }
      const planned = await listPlannedMeetingIds(ctx.callTool, contactId);
      if (planned.length !== 1 || planned[0] !== newId) {
        throw new SmokeAssertError(
          `replace-rebook: expected Planned=[${newId}], got [${planned.join(",")}]`,
        );
      }
      const newMeeting = await getMeeting(ctx.callTool, newId);
      const meetingStart = normalizeLocalIsoDatetime(String(newMeeting.dateStart));
      const slotStart = normalizeLocalIsoDatetime(selectedSlot.dateStart);
      if (meetingStart !== slotStart) {
        throw new SmokeAssertError(
          `replace-rebook: new dateStart ${meetingStart} !== slot ${slotStart}`,
        );
      }
      expectButtons("replace-rebook post menu", created.buttons, [
        DEFAULT_MENU_HAS_VISITS[0],
        MAIN_MENU_LABEL,
      ]);
      console.log("✓ replace-rebook: cancelled", oldId, "booked", newId);
      return { warnings: bundle.warnings, turns: bundle.session.turns };
    } finally {
      bundle.restore();
    }
  },
};

/**
 * Accepted non-consultation procedure → REPLACE → cancel confirm must continue
 * into date/time for that same service (not "Запис скасовано." + default menu).
 */
export const replaceProcedureScenario: SmokeScenario = {
  name: "replace-procedure",
  tier: "write",
  run: async (ctx) => {
    const telegramId = writeTelegramId("e");
    const { contactId, phone } = await prepareFreshContact(ctx, telegramId);
    const bundle = openBookingSession(ctx, "replace-procedure", telegramId);
    try {
      const first = await runBookFlow(bundle, {
        phone,
        decision: "confirm",
        ...SMOKE_CONTACT_NAME,
      });
      const oldId = await resolveCreatedMeetingId(ctx, contactId, first.allCalls);

      // Do not use openBookingOffer («Записатись»): with a visit on file that
      // opens REPLACE before any service is chosen. Mirror the live catalog path.
      const hasOfferKeyboard = (buttons: string[]): boolean =>
        buttons.includes(BOOKING_OFFER_MENU[0]) && buttons.includes(BOOKING_OFFER_MENU[1]);
      let servicesTurn = await bundle.session.say("Послуги");
      for (let i = 0; i < 4 && !hasOfferKeyboard(servicesTurn.buttons); i += 1) {
        servicesTurn = await bundle.session.say("Послуги");
      }
      if (!hasOfferKeyboard(servicesTurn.buttons)) {
        throw new SmokeAssertError(
          `replace-procedure: expected BOOKING OFFER after Послуги, got [${servicesTurn.buttons.join(" | ") || "none"}]`,
        );
      }

      const offer = await drillToProcedureOffer(bundle.session, "replace-procedure");
      const interaction = offer.state.pendingInteraction;
      if (interaction?.kind !== "service_confirm") {
        throw new SmokeAssertError(
          `replace-procedure: expected service_confirm, got ${interaction?.kind ?? "null"}`,
        );
      }
      const service = interaction.service;
      if (!service.id || service.id === CONSULTATION_SERVICE_ID) {
        throw new SmokeAssertError(
          `replace-procedure: expected non-consultation service id, got ${service.id}`,
        );
      }

      const acceptTurn = await bundle.session.tap(BOOKING_OFFER_MENU[0]);
      if (
        acceptTurn.state.pendingInteraction?.kind !== "visit_select"
        || acceptTurn.state.pendingInteraction.stage !== "replacement"
      ) {
        throw new SmokeAssertError(
          `replace-procedure: expected visit_select/replacement after Так, got ${acceptTurn.state.pendingInteraction?.kind ?? "null"}/${acceptTurn.state.pendingInteraction?.kind === "visit_select" ? acceptTurn.state.pendingInteraction.stage : "n/a"}`,
        );
      }
      expectButtons("replace-procedure REPLACE", acceptTurn.buttons, [...BOOKING_REPLACE_MENU]);
      assertNoCreateMeeting("replace-procedure REPLACE turn", acceptTurn.calls);

      const cancelTap = await bundle.session.tap("Скасувати");
      if (!cancelTap.pendingConfirm) {
        await driveUntilMutationConfirm(bundle, {
          phone,
          ...SMOKE_CONTACT_NAME,
          expectAction: "cancel",
          maxTurns: 6,
        });
      }
      const atCancel = await bundle.session.snapshot();
      if (
        atCancel.state.pendingInteraction?.kind !== "mutation_confirm"
        || atCancel.state.pendingInteraction.action !== "cancel"
      ) {
        throw new SmokeAssertError(
          `replace-procedure: expected cancel HITL for ${oldId}, got ${atCancel.state.pendingInteraction?.kind ?? "null"}`,
        );
      }

      const cancelConfirmed = await confirmOpenHitl(bundle);
      const oldAfterCancel = await getMeeting(ctx.callTool, oldId);
      if (oldAfterCancel.status !== "Not Held") {
        throw new SmokeAssertError(
          `replace-procedure: expected old meeting Not Held, got ${String(oldAfterCancel.status)}`,
        );
      }
      if (cancelConfirmed.reply.trim() === "Запис скасовано.") {
        throw new SmokeAssertError(
          "replace-procedure: cancel closed the booking with terminal «Запис скасовано.»",
        );
      }
      const idleDefault =
        cancelConfirmed.buttons.includes(DEFAULT_MENU_NO_VISITS[0])
        && cancelConfirmed.buttons.includes(DEFAULT_MENU_NO_VISITS[1])
        && cancelConfirmed.buttons.includes(DEFAULT_MENU_NO_VISITS[2]);
      const idleHasVisit =
        cancelConfirmed.buttons.includes(DEFAULT_MENU_HAS_VISITS[0])
        && cancelConfirmed.buttons.includes(DEFAULT_MENU_HAS_VISITS[1]);
      if (idleDefault || idleHasVisit) {
        throw new SmokeAssertError(
          `replace-procedure: cancel showed idle default menu [${cancelConfirmed.buttons.join(" | ")}]`,
        );
      }
      const pendingKind = cancelConfirmed.state.pendingInteraction?.kind;
      if (pendingKind !== "date_select" && pendingKind !== "time_select") {
        throw new SmokeAssertError(
          `replace-procedure: expected date_select/time_select after cancel, got ${pendingKind ?? "null"}`,
        );
      }
      const acceptedId = cancelConfirmed.state.bookingDraft?.serviceAcceptance?.service.id;
      if (acceptedId !== service.id) {
        throw new SmokeAssertError(
          `replace-procedure: expected accepted service ${service.id} after cancel, got ${acceptedId ?? "null"}`,
        );
      }
      if (cancelConfirmed.state.bookingDraft?.replacement != null) {
        throw new SmokeAssertError(
          "replace-procedure: bookingDraft.replacement still set after cancel confirm",
        );
      }

      const driveCreate = await driveUntilMutationConfirm(bundle, {
        phone,
        ...SMOKE_CONTACT_NAME,
        expectAction: "create",
        maxTurns: 14,
      });
      const created = await confirmOpenHitl(bundle);
      const allPostReplace = [
        ...cancelTap.calls,
        ...cancelConfirmed.calls,
        ...driveCreate.flatMap((turn) => turn.calls),
        ...created.calls,
      ];
      assertCreateMeetingOnce("replace-procedure create", allPostReplace);
      const createCall = allPostReplace.find((call) => call.name === "create_meeting");
      const serviceIds = createCall?.args.cServicesIds;
      const firstServiceId = Array.isArray(serviceIds) ? serviceIds[0] : undefined;
      if (firstServiceId !== service.id) {
        throw new SmokeAssertError(
          `replace-procedure: create_meeting cServicesIds[0]=${String(firstServiceId)}, expected ${service.id}`,
        );
      }

      const newId = await resolveCreatedMeetingId(ctx, contactId, allPostReplace);
      if (newId === oldId) {
        throw new SmokeAssertError(
          `replace-procedure: expected a new meeting id, got same ${oldId}`,
        );
      }
      const planned = await listPlannedMeetingIds(ctx.callTool, contactId);
      if (planned.length !== 1 || planned[0] !== newId) {
        throw new SmokeAssertError(
          `replace-procedure: expected Planned=[${newId}], got [${planned.join(",")}]`,
        );
      }
      const crmServices = await getMeetingServiceIds(ctx.callTool, newId);
      if (!crmServices.includes(service.id)) {
        throw new SmokeAssertError(
          `replace-procedure: CRM meeting services ${JSON.stringify(crmServices)} missing ${service.id}`,
        );
      }
      console.log(
        "✓ replace-procedure: cancelled",
        oldId,
        "booked",
        newId,
        "service",
        service.id,
      );
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
      const oldDay = dayFromLocalIso(oldStart);
      const oldHhmm = hhmmFromLocalIso(oldStart);

      const myVisitDecline = await bundle.session.say("Мій запис");
      expectButtons("reschedule visit menu decline", myVisitDecline.buttons, [
        ...VISIT_CHANGE_MENU,
      ]);
      await bundle.session.tap("Перенести");
      const declineDrive = await driveUntilMutationConfirm(bundle, {
        phone,
        ...SMOKE_CONTACT_NAME,
        expectAction: "reschedule",
        maxTurns: 12,
      });
      const excluded = declineDrive.some((turn) =>
        (turn.state.availabilityContext?.excludeMeetingIds ?? []).includes(meetingId),
      );
      if (!excluded) {
        throw new SmokeAssertError(
          `reschedule: expected availabilityContext.excludeMeetingIds to include ${meetingId}`,
        );
      }
      for (const turn of declineDrive) {
        const interaction = turn.state.pendingInteraction;
        if (interaction?.kind !== "time_select" || oldDay == null || oldHhmm == null) {
          continue;
        }
        if (interaction.date !== oldDay) {
          continue;
        }
        const labels = interaction.choices.map((choice) => choice.label);
        if (labels.includes(oldHhmm)) {
          throw new SmokeAssertError(
            `reschedule: old start ${oldHhmm} still offered on ${oldDay}`,
          );
        }
      }
      const declined = await declineOpenHitl(bundle);
      expectNotCalled("reschedule decline", declined.calls, "update_meeting");
      const still = await getMeeting(ctx.callTool, meetingId);
      if (String(still.dateStart) !== oldStart) {
        throw new SmokeAssertError(
          `reschedule: dateStart changed after ❌ (${oldStart} → ${String(still.dateStart)})`,
        );
      }

      // Decline can leave booking mid-slot; reset then re-open visit change.
      await bundle.session.say(MAIN_MENU_LABEL);
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
      console.log("✓ reschedule: declined then moved", oldStart, "→", newStart);
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

      const myVisitAgain = await bundle.session.say("Мій запис");
      expectButtons("cancel-hitl-faq visit menu again", myVisitAgain.buttons, [
        ...VISIT_CHANGE_MENU,
      ]);
      const cancelAgain = await bundle.session.tap("Скасувати");
      if (!cancelAgain.pendingConfirm) {
        await driveUntilMutationConfirm(bundle, {
          phone,
          ...SMOKE_CONTACT_NAME,
          expectAction: "cancel",
          maxTurns: 6,
        });
      }
      const leave = await bundle.session.say(MAIN_MENU_LABEL);
      const notHeldUpdates = leave.calls.filter(
        (call) =>
          call.name === "update_meeting"
          && (call.args as { status?: string }).status === "Not Held",
      );
      if (notHeldUpdates.length > 0) {
        throw new SmokeAssertError(
          "cancel-hitl-faq: Головне меню wrote Not Held",
        );
      }
      if (leave.pendingConfirm) {
        throw new SmokeAssertError(
          "cancel-hitl-faq: pendingConfirm still open after Головне меню",
        );
      }
      const kept = await getMeeting(ctx.callTool, meetingId);
      if (kept.status !== "Planned" && kept.status !== "Confirmed") {
        throw new SmokeAssertError(
          `cancel-hitl-faq: expected Planned/Confirmed after Головне меню, got ${String(kept.status)}`,
        );
      }
      console.log("✓ cancel-hitl-faq: FAQ aside + ❌ + Головне меню kept visit");
      return { warnings: bundle.warnings, turns: bundle.session.turns };
    } finally {
      bundle.restore();
    }
  },
};

export const contactLinkScenario: SmokeScenario = {
  name: "contact-link",
  tier: "write",
  run: async (ctx) => {
    const telegramId = writeTelegramId("e");
    await preCleanTelegramContact(ctx.callTool, telegramId);
    const phone = await allocateUnusedSmokePhone(ctx.callTool);
    const seededId = await seedPhoneOnlyContact(ctx.callTool, phone);
    ctx.cleanup.trackContact(seededId);

    const bundle = openBookingSession(ctx, "contact-link", telegramId);
    try {
      const flow = await runBookFlow(bundle, {
        phone,
        decision: "confirm",
        rotateOccupiedPhone: false,
        ...SMOKE_CONTACT_NAME,
      });
      if (flow.allCalls.some((call) => call.name === "create_contact")) {
        throw new SmokeAssertError(
          "contact-link: create_contact must not run when phone matches existing Contact",
        );
      }
      const linked = flow.allCalls.some((call) => {
        if (call.name !== "update_entity") {
          return false;
        }
        const args = call.args as {
          entityId?: string;
          data?: { cTelegram?: string };
        };
        return args.entityId === seededId && args.data?.cTelegram === telegramId;
      });
      if (!linked) {
        throw new SmokeAssertError(
          `contact-link: expected update_entity cTelegram=${telegramId} on Contact ${seededId}`,
        );
      }
      const found = await findContactByTelegram(ctx.callTool, telegramId);
      if (!found || found.id !== seededId) {
        throw new SmokeAssertError(
          `contact-link: expected telegram ${telegramId} → Contact ${seededId}, got ${found?.id ?? "none"}`,
        );
      }
      const meetingId = await resolveCreatedMeetingId(ctx, seededId, flow.allCalls);
      await assertMeetingPlanned(ctx, meetingId, seededId);

      const phoneTurn = flow.turns.find(
        (turn) =>
          turn.state.pendingInteraction?.kind === "contact_field"
          && turn.state.pendingInteraction.field === "phoneNumber",
      );
      // Soft: reply after submitting phone should not re-ask for phone.
      const afterPhoneIdx = phoneTurn
        ? flow.turns.indexOf(phoneTurn) + 1
        : -1;
      if (afterPhoneIdx >= 0 && afterPhoneIdx < flow.turns.length) {
        const afterPhone = flow.turns[afterPhoneIdx]!;
        soft(
          bundle.warnings,
          "contact-link reply re-asked for phone after match",
          !/(?:телефон|номер|phone)/i.test(afterPhone.reply)
            || afterPhone.state.pendingInteraction?.kind !== "contact_field"
            || afterPhone.state.pendingInteraction.field !== "phoneNumber",
          afterPhone.reply.slice(0, 200),
        );
      }
      console.log("✓ contact-link: linked", seededId, "meeting", meetingId);
      return { warnings: bundle.warnings, turns: bundle.session.turns };
    } finally {
      bundle.restore();
    }
  },
};

export const bookProcedureScenario: SmokeScenario = {
  name: "book-procedure",
  tier: "write",
  run: async (ctx) => {
    const telegramId = writeTelegramId("f");
    const { contactId, phone } = await prepareFreshContact(ctx, telegramId);
    const bundle = openBookingSession(ctx, "book-procedure", telegramId);
    try {
      await openBookingOffer(bundle.session, "book-procedure");
      const offer = await drillToProcedureOffer(bundle.session, "book-procedure");
      const interaction = offer.state.pendingInteraction;
      if (interaction?.kind !== "service_confirm") {
        throw new SmokeAssertError(
          `book-procedure: expected service_confirm, got ${interaction?.kind ?? "null"}`,
        );
      }
      const service = interaction.service;
      if (!service.id || service.id === CONSULTATION_SERVICE_ID) {
        throw new SmokeAssertError(
          `book-procedure: expected non-consultation service id, got ${service.id}`,
        );
      }

      await bundle.session.tap(BOOKING_OFFER_MENU[0]);
      await driveUntilMutationConfirm(bundle, {
        phone,
        ...SMOKE_CONTACT_NAME,
        expectAction: "create",
      });
      const confirmed = await confirmOpenHitl(bundle);
      assertCreateMeetingOnce("book-procedure", confirmed.calls);
      const createCall = confirmed.calls.find((call) => call.name === "create_meeting");
      const serviceIds = createCall?.args.cServicesIds;
      const firstServiceId = Array.isArray(serviceIds) ? serviceIds[0] : undefined;
      if (firstServiceId !== service.id) {
        throw new SmokeAssertError(
          `book-procedure: create_meeting cServicesIds[0]=${String(firstServiceId)}, expected ${service.id}`,
        );
      }
      if (firstServiceId === CONSULTATION_SERVICE_ID) {
        throw new SmokeAssertError(
          "book-procedure: create_meeting used consultation service id",
        );
      }
      const meetingId = await resolveCreatedMeetingId(ctx, contactId, confirmed.calls);
      const meeting = await assertMeetingPlanned(ctx, meetingId, contactId);
      const crmServices = await getMeetingServiceIds(ctx.callTool, meetingId);
      if (crmServices.length === 0) {
        throw new SmokeAssertError(
          `book-procedure: CRM meeting ${meetingId} has no linked cServicesIds (create wrote serviceId=${service.id})`,
        );
      }
      if (!crmServices.includes(service.id)) {
        throw new SmokeAssertError(
          `book-procedure: CRM meeting services ${JSON.stringify(crmServices)} missing ${service.id}`,
        );
      }
      const dateStart = String(meeting.dateStart ?? "");
      const dateEnd = String(meeting.dateEnd ?? "");
      const durationMinutes =
        typeof service.durationMinutes === "number"
        && Number.isFinite(service.durationMinutes)
          ? service.durationMinutes
          : null;
      if (durationMinutes != null && dateStart.includes("T") && dateEnd.includes("T")) {
        const startMs = Date.parse(dateStart);
        const endMs = Date.parse(dateEnd);
        if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
          soft(
            bundle.warnings,
            "book-procedure duration matches service",
            Math.round((endMs - startMs) / 60_000) === durationMinutes,
            `expected ${durationMinutes}m got ${Math.round((endMs - startMs) / 60_000)}m`,
          );
        }
      }
      console.log("✓ book-procedure: service", service.id, "meeting", meetingId);
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
