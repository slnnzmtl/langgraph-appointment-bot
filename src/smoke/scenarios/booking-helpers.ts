import {
  expectCalled,
  expectNotCalled,
  SmokeAssertError,
} from "../assert.js";
import {
  allocateUnusedSmokePhone,
  ensureSmokeContact,
  extractMeetingIdFromCreateCalls,
  findContactByTelegram,
  getMeeting,
  listPlannedMeetingIds,
  preCleanTelegramContact,
} from "../crm.js";
import { SMOKE_CONTACT_NAME, uniqueSmokePhone } from "../env.js";
import {
  createSmokeSession,
  installCallToolRecorder,
  type SmokeSession,
  type TurnResult,
} from "../harness.js";
import { nextAutopilotInput } from "../autopilot.js";
import {
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  LATER_DATE_LABEL,
} from "../../shared/clinic-constants.js";
import type { ScenarioContext, SoftWarning } from "../types.js";

export const WRITE_MCP_TOOLS = [
  "create_meeting",
  "update_meeting",
] as const;

export type BookingSessionBundle = {
  session: SmokeSession;
  recorder: ReturnType<typeof installCallToolRecorder>;
  warnings: SoftWarning[];
  restore: () => void;
};

export const openBookingSession = (
  ctx: ScenarioContext,
  scenario: string,
  telegramId: string,
): BookingSessionBundle => {
  const warnings: SoftWarning[] = [];
  const recorder = installCallToolRecorder(
    ctx.runtime.getBootstrap().adapters,
    ctx.cleanup,
  );
  const session = createSmokeSession(ctx.runtime, {
    telegramId,
    scenario,
    recorder,
    cleanup: ctx.cleanup,
  });
  return {
    session,
    recorder,
    warnings,
    restore: () => recorder.restore(),
  };
};

export const prepareFreshContact = async (
  ctx: ScenarioContext,
  telegramId: string,
  phone?: string,
): Promise<{ contactId: string; phone: string }> => {
  const phoneNumber = phone ?? await allocateUnusedSmokePhone(ctx.callTool);
  await preCleanTelegramContact(ctx.callTool, telegramId);
  const contact = await ensureSmokeContact(ctx.callTool, telegramId, {
    firstName: SMOKE_CONTACT_NAME.firstName,
    lastName: SMOKE_CONTACT_NAME.lastName,
    phoneNumber,
  });
  // Repair contacts left over from older smoke runs (dummy lastName "Patient", shared phone).
  try {
    await ctx.callTool("update_entity", {
      entityType: "Contact",
      entityId: contact.id,
      data: {
        firstName: SMOKE_CONTACT_NAME.firstName,
        lastName: SMOKE_CONTACT_NAME.lastName,
        phoneNumber,
        cTelegram: telegramId,
      },
    });
  } catch (error: unknown) {
    console.warn(
      `⚠ prepareFreshContact: could not refresh Contact ${contact.id}:`,
      error instanceof Error ? error.message : error,
    );
  }
  ctx.cleanup.trackContact(contact.id);
  await preCleanTelegramContact(ctx.callTool, telegramId);
  return { contactId: contact.id, phone: phoneNumber };
};

/** Drive until mutation HITL is open; does not tap ✅/❌. */
export const driveUntilMutationConfirm = async (
  bundle: BookingSessionBundle,
  options: { phone: string; firstName?: string; lastName?: string; maxTurns?: number },
): Promise<TurnResult[]> => {
  const { session } = bundle;
  const turns: TurnResult[] = [];
  const maxTurns = options.maxTurns ?? 14;
  const autopilotOpts = {
    phone: options.phone,
    firstName: options.firstName ?? SMOKE_CONTACT_NAME.firstName,
    lastName: options.lastName ?? SMOKE_CONTACT_NAME.lastName,
    decision: "confirm" as const,
  };
  let lastContactField: string | null = null;
  let sameContactFieldTurns = 0;
  let lastSlotLabel: string | null = null;
  let sameSlotTurns = 0;

  for (let i = 0; i < maxTurns; i += 1) {
    const snap = await session.snapshot();
    // LangGraph interrupt must be open — mutation_confirm in state without
    // pendingConfirm means ✅ would be a normal message, not HITL resume.
    if (snap.pendingConfirm) {
      return turns;
    }
    const interaction = snap.state.pendingInteraction;
    if (interaction?.kind === "contact_field") {
      if (lastContactField === interaction.field) {
        sameContactFieldTurns += 1;
      } else {
        sameContactFieldTurns = 1;
        lastContactField = interaction.field;
      }
      // Only rotate when CRM says the number is occupied — a repeated
      // phoneNumber prompt is the normal unresolved-contact ladder.
      if (interaction.field === "phoneNumber" && interaction.occupied) {
        autopilotOpts.phone = uniqueSmokePhone();
      }
      if (sameContactFieldTurns >= 6) {
        throw new SmokeAssertError(
          `${session.scenario}: stuck on contact_field=${interaction.field}${interaction.occupied ? " (occupied)" : ""} after ${sameContactFieldTurns} turns`,
        );
      }
    } else {
      lastContactField = null;
      sameContactFieldTurns = 0;
    }
    // Stale mutation_confirm after create chat-other: slot was invalidated and
    // create HITL is not re-armed — ask for another free time, do not agree in chat.
    if (
      interaction?.kind === "mutation_confirm"
      && !snap.pendingConfirm
    ) {
      const turn = await session.say("інший вільний час, будь ласка");
      turns.push(turn);
      if (turn.pendingConfirm) {
        return turns;
      }
      continue;
    }
    const next = nextAutopilotInput(
      {
        pendingInteraction: snap.state.pendingInteraction,
        pendingConfirm: snap.pendingConfirm,
      },
      autopilotOpts,
    );
    if (
      (interaction?.kind === "date_select" || interaction?.kind === "time_select")
      && next != null
    ) {
      if (next === lastSlotLabel) {
        sameSlotTurns += 1;
      } else {
        sameSlotTurns = 1;
        lastSlotLabel = next;
      }
      // Same chip twice means that day did not advance — page forward.
      if (sameSlotTurns >= 2 && snap.buttons.includes(LATER_DATE_LABEL)) {
        const turn = await session.tap(LATER_DATE_LABEL);
        turns.push(turn);
        lastSlotLabel = LATER_DATE_LABEL;
        sameSlotTurns = 0;
        if (turn.pendingConfirm) {
          return turns;
        }
        continue;
      }
    } else {
      lastSlotLabel = null;
      sameSlotTurns = 0;
    }
    if (next == null) {
      const turn = await session.say("продовжимо запис");
      turns.push(turn);
      if (turn.pendingConfirm) {
        return turns;
      }
      continue;
    }
    const chipKinds = new Set([
      "service_confirm",
      "date_select",
      "time_select",
      "visit_note",
    ]);
    if (
      interaction
      && chipKinds.has(interaction.kind)
      && !snap.buttons.includes(next)
    ) {
      throw new SmokeAssertError(
        `${session.scenario}: keyboard-only step ${interaction.kind} needs "${next}" on keyboard [${snap.buttons.join(" | ") || "none"}]`,
      );
    }
    const turn = snap.buttons.includes(next)
      ? await session.tap(next)
      : await session.say(next);
    turns.push(turn);
    if (turn.pendingConfirm) {
      return turns;
    }
  }

  const finalSnap = await session.snapshot();
  if (finalSnap.pendingConfirm) {
    return turns;
  }
  throw new SmokeAssertError(
    `${session.scenario}: never reached HITL interrupt (pendingInteraction=${finalSnap.state.pendingInteraction?.kind ?? "null"})`,
  );
};

/** Resume create/cancel/reschedule only while LangGraph is actually paused. */
export const confirmOpenHitl = async (
  bundle: BookingSessionBundle,
): Promise<TurnResult> => {
  const snap = await bundle.session.snapshot();
  if (!snap.pendingConfirm) {
    throw new SmokeAssertError(
      `${bundle.session.scenario}: no pending HITL interrupt (buttons=${snap.buttons.join("|") || "none"})`,
    );
  }
  return snap.buttons.includes(CONFIRM_YES_LABEL)
    ? bundle.session.tap(CONFIRM_YES_LABEL)
    : bundle.session.say(CONFIRM_YES_LABEL);
};

export const declineOpenHitl = async (
  bundle: BookingSessionBundle,
): Promise<TurnResult> => {
  const snap = await bundle.session.snapshot();
  if (!snap.pendingConfirm) {
    throw new SmokeAssertError(
      `${bundle.session.scenario}: no pending HITL interrupt to decline (buttons=${snap.buttons.join("|") || "none"})`,
    );
  }
  return snap.buttons.includes(CONFIRM_NO_LABEL)
    ? bundle.session.tap(CONFIRM_NO_LABEL)
    : bundle.session.say(CONFIRM_NO_LABEL);
};

/** Drive «Записатись» through HITL confirm/decline. */
export const runBookFlow = async (
  bundle: BookingSessionBundle,
  options: {
    phone: string;
    decision: "confirm" | "decline";
    firstName?: string;
    lastName?: string;
  },
): Promise<{
  turns: TurnResult[];
  last: TurnResult;
  allCalls: TurnResult["calls"];
  sawContactBeforeSlot: boolean;
  createBeforeConfirm: boolean;
}> => {
  const { session } = bundle;
  const start = await session.say("Записатись");
  let sawContactBeforeSlot = false;
  if (start.state.pendingInteraction?.kind === "contact_field") {
    sawContactBeforeSlot = true;
  }

  const driven = await driveUntilMutationConfirm(bundle, {
    phone: options.phone,
    maxTurns: 16,
    ...(options.firstName !== undefined ? { firstName: options.firstName } : {}),
    ...(options.lastName !== undefined ? { lastName: options.lastName } : {}),
  });
  const last =
    options.decision === "confirm"
      ? await confirmOpenHitl(bundle)
      : await declineOpenHitl(bundle);
  const turns = [...driven, last];

  const allTurns = [start, ...turns];
  for (let i = 0; i < allTurns.length; i += 1) {
    const turn = allTurns[i]!;
    if (turn.state.pendingInteraction?.kind !== "contact_field") {
      continue;
    }
    const draft = turn.state.bookingDraft;
    if (draft?.selectedSlot != null || draft?.selectedDate) {
      continue;
    }
    const hadSlotEarlier = allTurns
      .slice(0, i)
      .some((prior) => prior.state.bookingDraft?.selectedSlot != null);
    if (!hadSlotEarlier) {
      sawContactBeforeSlot = true;
    }
  }

  const allCalls = allTurns.flatMap((turn) => turn.calls);
  const confirmIndex = turns.findIndex(
    (turn) =>
      turn.pendingConfirm
      || turn.state.pendingInteraction?.kind === "mutation_confirm"
      || turn.buttons.includes("✅")
      || turn.buttons.includes("❌"),
  );
  // Calls before the confirm card turn (exclusive of the confirm-completing turn).
  let createBeforeConfirm = false;
  if (confirmIndex >= 0) {
    const beforeConfirm = [start, ...turns.slice(0, confirmIndex)].flatMap((t) => t.calls);
    createBeforeConfirm = beforeConfirm.some((call) => call.name === "create_meeting");
  } else if (options.decision === "confirm") {
    // Never reached confirm — still check no premature create in early turns.
    createBeforeConfirm = start.calls.some((call) => call.name === "create_meeting");
  }

  return {
    turns: allTurns,
    last,
    allCalls,
    sawContactBeforeSlot,
    createBeforeConfirm,
  };
};

export const assertMeetingPlanned = async (
  ctx: ScenarioContext,
  meetingId: string,
  contactId: string,
): Promise<Record<string, unknown>> => {
  const meeting = await getMeeting(ctx.callTool, meetingId);
  if (meeting.status !== "Planned" && meeting.status !== "Confirmed") {
    throw new SmokeAssertError(
      `expected meeting ${meetingId} Planned/Confirmed, got ${String(meeting.status)}`,
    );
  }
  const parentId = meeting.parentId;
  const contactsIds = meeting.contactsIds;
  const owns =
    parentId === contactId
    || (Array.isArray(contactsIds) && contactsIds.includes(contactId));
  if (!owns) {
    throw new SmokeAssertError(
      `meeting ${meetingId} not linked to contact ${contactId}`,
    );
  }
  return meeting;
};

export const resolveCreatedMeetingId = async (
  ctx: ScenarioContext,
  contactId: string,
  calls: TurnResult["calls"],
): Promise<string> => {
  const fromCalls = extractMeetingIdFromCreateCalls(calls);
  if (fromCalls) {
    ctx.cleanup.trackMeeting(fromCalls);
    return fromCalls;
  }
  const ids = await listPlannedMeetingIds(ctx.callTool, contactId);
  if (ids.length === 0) {
    throw new SmokeAssertError("expected a Planned meeting after confirm, found none");
  }
  for (const id of ids) {
    ctx.cleanup.trackMeeting(id);
  }
  return ids[0]!;
};

export const assertNoCreateMeeting = (label: string, calls: TurnResult["calls"]): void => {
  expectNotCalled(label, calls, "create_meeting");
};

export const assertCreateMeetingOnce = (label: string, calls: TurnResult["calls"]): void => {
  const creates = expectCalled(label, calls, "create_meeting");
  if (creates.length !== 1) {
    throw new SmokeAssertError(
      `${label}: expected exactly one create_meeting, got ${creates.length}`,
    );
  }
};

export const contactIdOrThrow = async (
  ctx: ScenarioContext,
  telegramId: string,
): Promise<string> => {
  const contact = await findContactByTelegram(ctx.callTool, telegramId);
  if (!contact) {
    throw new SmokeAssertError(`contact missing for telegram ${telegramId}`);
  }
  return contact.id;
};
