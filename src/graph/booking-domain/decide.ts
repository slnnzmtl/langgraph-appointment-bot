import type { BookingDecision, BookingInput, BookingReadModels, BookingView } from "./decision.js";
import type { BookingEffect, EffectResult, PendingEffect } from "./effects.js";
import { nextBookingRequirement } from "./requirement.js";
import type { BookingSessionV2, SlotFacts } from "./session.js";
import type { UnderstoodBookingTurn } from "./turn.js";

const plainView = (replyText: string, card: BookingView["card"] = null): BookingView => ({
  replyText,
  card,
});

const bump = (session: BookingSessionV2): BookingSessionV2 => ({
  ...session,
  revision: session.revision + 1,
});

type MeetingWriteEffect = Extract<
  BookingEffect,
  { kind: "create_meeting" | "reschedule_meeting" | "cancel_meeting" }
>;

const asMeetingWrite = (effect: BookingEffect): MeetingWriteEffect | null =>
  effect.kind === "create_meeting"
  || effect.kind === "reschedule_meeting"
  || effect.kind === "cancel_meeting"
    ? effect
    : null;

const sameWriteEffect = (a: BookingEffect, b: BookingEffect): boolean => {
  const left = asMeetingWrite(a);
  const right = asMeetingWrite(b);
  if (left == null || right == null || left.kind !== right.kind) {
    return false;
  }
  return JSON.stringify(left.payload) === JSON.stringify(right.payload);
};

/**
 * Persist PendingEffect on the session. Re-entry with the same frozen write
 * reuses the existing effect id (emit once). Completed writes are not re-emitted.
 */
const withPendingEffect = (
  session: BookingSessionV2,
  effect: BookingEffect,
): { session: BookingSessionV2; pendingEffect: PendingEffect } => {
  const existing = session.pendingEffect;
  if (
    existing != null
    && (existing.status === "prepared" || existing.status === "executing")
    && sameWriteEffect(existing.effect, effect)
  ) {
    const pendingEffect: PendingEffect = {
      ...existing,
      status: existing.status === "prepared" ? "executing" : existing.status,
    };
    return {
      session: {
        ...session,
        pendingEffect,
      },
      pendingEffect,
    };
  }
  if (
    existing != null
    && existing.status === "completed"
    && sameWriteEffect(existing.effect, effect)
  ) {
    // Completed write must not be emitted again — force a clarification path.
    const pendingEffect: PendingEffect = { ...existing, status: "completed" };
    return {
      session: {
        ...session,
        pendingEffect,
      },
      pendingEffect,
    };
  }

  const pendingEffect: PendingEffect = {
    id: `eff_${session.revision + 1}_${effect.kind}`,
    expectedRevision: session.revision + 1,
    effect,
    status: "prepared",
  };
  return {
    session: {
      ...bump(session),
      pendingEffect,
      pendingCommand: (() => {
        const write = asMeetingWrite(effect);
        if (write == null) {
          return session.pendingCommand;
        }
        return {
          action:
            write.kind === "create_meeting"
              ? "create"
              : write.kind === "reschedule_meeting"
                ? "reschedule"
                : "cancel",
          payload: { ...write.payload, effectId: pendingEffect.id },
        };
      })(),
    },
    pendingEffect,
  };
};

const clearPendingEffect = (session: BookingSessionV2): BookingSessionV2 => ({
  ...session,
  pendingEffect: null,
});

const demoteSlot = (slot: SlotFacts | null): SlotFacts | null => {
  if (slot == null) {
    return null;
  }
  const { evidence: _dropped, ...rest } = slot;
  return { ...rest, provenance: "unverified_legacy" };
};

const applyControl = (
  session: BookingSessionV2,
  intent: "menu" | "abandon" | "handoff",
): BookingDecision => {
  if (intent === "abandon" || intent === "menu") {
    return {
      tag: "terminal",
      session: null,
      view: plainView(intent === "menu" ? "Повертаю до головного меню." : "Добре, скасовую запис."),
      reason: intent === "menu" ? "menu" : "abandon",
    };
  }
  return {
    tag: "terminal",
    session: bump(session),
    view: plainView("З'єднаю вас з адміністратором."),
    reason: "handoff",
  };
};

const contactNamesComplete = (session: BookingSessionV2): boolean => {
  const { phoneNumber, firstName, lastName } = session.contact;
  return (
    phoneNumber != null
    && phoneNumber.trim() !== ""
    && firstName != null
    && firstName.trim() !== ""
    && lastName != null
    && lastName.trim() !== ""
  );
};

const nextContactField = (
  session: BookingSessionV2,
): "phoneNumber" | "firstName" | "lastName" | null => {
  if (session.contact.phoneNumber == null || session.contact.phoneNumber.trim() === "") {
    return "phoneNumber";
  }
  if (session.contact.firstName == null || session.contact.firstName.trim() === "") {
    return "firstName";
  }
  if (session.contact.lastName == null || session.contact.lastName.trim() === "") {
    return "lastName";
  }
  return null;
};

const askContactField = (
  session: BookingSessionV2,
  field: "phoneNumber" | "firstName" | "lastName",
): BookingDecision => ({
  tag: "ask",
  session,
  pendingDecision: { kind: "clarification", reason: `need_${field}` },
  view: plainView(
    field === "phoneNumber"
      ? "Вкажіть номер телефону."
      : field === "firstName"
        ? "Вкажіть ім'я."
        : "Вкажіть прізвище.",
    { kind: "contact_field", field },
  ),
});

/** Contact identity ladder after phone is known and contactId is missing. */
const decideContactDetails = (
  session: BookingSessionV2,
  readModels: BookingReadModels,
): BookingDecision => {
  const phone = session.contact.phoneNumber?.trim();
  if (phone == null || phone === "") {
    return askContactField(session, "phoneNumber");
  }

  const lookup = session.contact.phoneLookup;
  const needsLookup =
    lookup == null
    || lookup.phoneNumber !== phone
    || session.pendingEffect?.effect.kind === "lookup_contact_by_phone";

  // Always look up once for the accepted phone before asking more names or creating.
  if (lookup == null || lookup.phoneNumber !== phone) {
    const { session: next, pendingEffect } = withPendingEffect(session, {
      kind: "lookup_contact_by_phone",
      phoneNumber: phone,
    });
    return { tag: "effect", session: next, pendingEffect };
  }

  if (lookup.result === "occupied" || lookup.result === "ambiguous") {
    return {
      tag: "ask",
      session,
      pendingDecision: {
        kind: "clarification",
        reason: lookup.result === "occupied" ? "phone_occupied" : "phone_ambiguous",
      },
      view: plainView(
        lookup.result === "occupied"
          ? "Цей номер уже прив'язаний до іншого акаунту. Зверніться до адміністратора."
          : "Знайдено кілька контактів за цим номером. Зверніться до адміністратора.",
      ),
    };
  }

  if (lookup.result === "single_linkable" && lookup.contactIds[0] != null) {
    const contactId = lookup.contactIds[0];
    if (session.contact.contactId !== contactId) {
      const { session: next, pendingEffect } = withPendingEffect(session, {
        kind: "link_telegram_contact",
        contactId,
      });
      return { tag: "effect", session: next, pendingEffect };
    }
  }

  const missing = nextContactField(session);
  if (missing != null) {
    return askContactField(session, missing);
  }

  if (lookup.result === "none" && contactNamesComplete(session) && session.contact.contactId == null) {
    const { session: next, pendingEffect } = withPendingEffect(session, {
      kind: "create_contact",
      payload: {
        phoneNumber: phone,
        firstName: session.contact.firstName!.trim(),
        lastName: session.contact.lastName!.trim(),
      },
    });
    return { tag: "effect", session: next, pendingEffect };
  }

  // Avoid unused-arg lint when ladder falls through after a pending lookup write.
  void needsLookup;
  void readModels;
  return askContactField(session, "lastName");
};

const emitMutationConfirm = (
  session: BookingSessionV2,
  effect: Extract<
    BookingEffect,
    { kind: "create_meeting" | "reschedule_meeting" | "cancel_meeting" }
  >,
  action: "create" | "reschedule" | "cancel",
  confirmText: string,
): BookingDecision => {
  // Exact-slot revalidate before freezing a create/reschedule write.
  if (
    (action === "create" || action === "reschedule")
    && session.selectedSlot != null
    && (
      session.selectedSlot.provenance !== "availability_tool"
      || session.selectedSlot.evidence?.snapshotId == null
    )
  ) {
    const { session: next, pendingEffect } = withPendingEffect(session, {
      kind: "present_availability",
      queryKind: "exact",
      date: session.selectedDate ?? session.selectedSlot.dateStart.slice(0, 10),
      preferredTime: session.selectedSlot.dateStart.slice(11, 16),
      revalidate: true,
    });
    return { tag: "effect", session: next, pendingEffect };
  }

  const { session: next, pendingEffect } = withPendingEffect(session, effect);
  if (pendingEffect.status === "completed") {
    return {
      tag: "ask",
      session: next,
      pendingDecision: { kind: "clarification", reason: "effect_already_completed" },
      view: plainView("Цю дію вже виконано. Уточніть, будь ласка."),
    };
  }
  return {
    tag: "mutation_confirm",
    session: {
      ...next,
      pendingDecision: {
        kind: "mutation_confirm",
        action,
        effectId: pendingEffect.id,
      },
    },
    pendingEffect,
    view: plainView(confirmText, {
      kind: "mutation_confirm",
      action,
      effectId: pendingEffect.id,
    }),
  };
};

const applyEffectResult = (
  session: BookingSessionV2,
  result: EffectResult,
): BookingDecision => {
  const pending = session.pendingEffect;
  if (pending != null && result.effectId !== pending.id) {
    return {
      tag: "ask",
      session: bump(session),
      pendingDecision: { kind: "clarification", reason: "effect_id_mismatch" },
      view: plainView("Не вдалося зіставити результат дії. Уточніть, будь ласка."),
    };
  }

  if (result.kind === "mutation") {
    if (result.outcome === "unknown") {
      const effect: BookingEffect = { kind: "get_working_time" };
      return {
        tag: "effect",
        ...withPendingEffect(
          clearPendingEffect({
            ...session,
            pendingCommand: null,
            pendingDecision: { kind: "clarification", reason: "mutation_outcome_unknown" },
            selectedSlot: demoteSlot(session.selectedSlot),
          }),
          effect,
        ),
      };
    }
    if (result.outcome === "committed") {
      // Replacement cancel → create continuation.
      if (
        result.action === "cancel"
        && session.mode === "replace"
        && session.replacement?.status === "cancelling"
        && session.replacement.originalCommand?.action === "create"
      ) {
        const original = session.replacement.originalCommand;
        const continued: BookingSessionV2 = {
          ...clearPendingEffect(session),
          mode: "replace",
          replacement: {
            ...session.replacement,
            status: "create_pending",
          },
          pendingCommand: null,
          pendingDecision: null,
        };
        return emitMutationConfirm(
          bump(continued),
          {
            kind: "create_meeting",
            payload: { ...original.payload },
          },
          "create",
          "Підтвердити новий запис?",
        );
      }
      return {
        tag: "terminal",
        session: null,
        view: plainView("Готово! Запис підтверджено."),
        reason: "success",
      };
    }
    if (result.outcome === "declined") {
      return {
        tag: "terminal",
        session: null,
        view: plainView("Добре, скасовую підтвердження."),
        reason: "abandon",
      };
    }
    return {
      tag: "reply",
      session: clearPendingEffect({
        ...bump(session),
        pendingCommand: null,
        pendingDecision: null,
      }),
      view: plainView("Не вдалося змінити запис. Спробуйте ще раз."),
    };
  }

  if (result.kind === "availability") {
    const base = clearPendingEffect(session);
    if (result.outcome === "stale" || result.outcome === "error") {
      const next = {
        ...base,
        selectedSlot: demoteSlot(base.selectedSlot),
        pendingCommand: null,
      };
      return decideFromRequirement(bump(next), {
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: false,
      });
    }
    if (result.outcome === "empty" || result.outcome === "closed") {
      return {
        tag: "ask",
        session: bump(base),
        pendingDecision: { kind: "clarification", reason: "availability_empty" },
        view: plainView("На цей час немає вільних слотів. Оберіть іншу дату."),
      };
    }
    const verified =
      base.selectedSlot != null
      && pending?.effect.kind === "present_availability"
      && pending.effect.revalidate === true
        ? {
            ...base.selectedSlot,
            provenance: "availability_tool" as const,
            evidence: {
              snapshotId: result.snapshotId ?? `revalidated:${base.revision}`,
              ...(base.serviceAcceptance?.service.id != null
                ? { serviceId: base.serviceAcceptance.service.id }
                : {}),
              ...(base.serviceAcceptance?.service.durationMinutes != null
                ? { durationMinutes: base.serviceAcceptance.service.durationMinutes }
                : {}),
            },
          }
        : base.selectedSlot;
    return decideFromRequirement(
      bump({
        ...base,
        selectedSlot: verified,
      }),
      {
        contactContextDirty: false,
        bookingContextDirty: false,
        availabilityVerified: true,
      },
    );
  }

  if (result.kind === "contact_lookup") {
    const contact = { ...session.contact };
    if (result.outcome === "single_linkable" && result.contactIds?.[0]) {
      contact.phoneLookup = {
        phoneNumber: contact.phoneNumber ?? "",
        result: "single_linkable",
        contactIds: result.contactIds,
      };
    } else if (
      result.outcome === "none"
      || result.outcome === "occupied"
      || result.outcome === "ambiguous"
    ) {
      contact.phoneLookup = {
        phoneNumber: contact.phoneNumber ?? "",
        result: result.outcome,
        contactIds: result.contactIds ?? [],
      };
    }
    return decideFromRequirement(
      bump(clearPendingEffect({ ...session, contact })),
      { contactContextDirty: false, bookingContextDirty: false, availabilityVerified: true },
    );
  }

  if (result.kind === "contact_write") {
    const base = clearPendingEffect(session);
    if (
      (result.outcome === "created" || result.outcome === "updated" || result.outcome === "linked")
      && result.contactId != null
    ) {
      return decideFromRequirement(
        bump({
          ...base,
          contact: {
            ...base.contact,
            contactId: result.contactId,
          },
        }),
        { contactContextDirty: false, bookingContextDirty: false, availabilityVerified: true },
      );
    }
    return {
      tag: "ask",
      session: bump(base),
      pendingDecision: { kind: "clarification", reason: "contact_write_failed" },
      view: plainView("Не вдалося зберегти контакт. Спробуйте ще раз."),
    };
  }

  return decideFromRequirement(bump(clearPendingEffect(session)), {
    contactContextDirty: false,
    bookingContextDirty: false,
    availabilityVerified: true,
  });
};

const decideFromRequirement = (
  session: BookingSessionV2,
  readModels: BookingReadModels,
): BookingDecision => {
  // Resume a prepared/executing write without minting a new effect id.
  if (
    session.pendingDecision?.kind === "mutation_confirm"
    && session.pendingCommand != null
    && session.pendingEffect != null
    && (session.pendingEffect.status === "prepared" || session.pendingEffect.status === "executing")
  ) {
    return {
      tag: "mutation_confirm",
      session,
      pendingEffect: session.pendingEffect,
      view: plainView(
        session.pendingDecision.action === "cancel"
          ? "Підтвердити скасування?"
          : session.pendingDecision.action === "reschedule"
            ? "Підтвердити перенесення?"
            : "Підтвердити запис?",
        {
          kind: "mutation_confirm",
          action: session.pendingDecision.action,
          effectId: session.pendingEffect.id,
        },
      ),
    };
  }

  if (session.pendingDecision?.kind === "mutation_confirm" && session.pendingCommand != null) {
    const action = session.pendingDecision.action;
    const effectKind =
      action === "create"
        ? "create_meeting" as const
        : action === "reschedule"
          ? "reschedule_meeting" as const
          : "cancel_meeting" as const;
    return emitMutationConfirm(
      session,
      {
        kind: effectKind,
        payload: { ...session.pendingCommand.payload },
      },
      action,
      action === "cancel"
        ? "Підтвердити скасування?"
        : action === "reschedule"
          ? "Підтвердити перенесення?"
          : "Підтвердити запис?",
    );
  }

  // Pending service confirmation.
  if (session.serviceAcceptance?.status === "pending") {
    return {
      tag: "ask",
      session,
      pendingDecision: { kind: "clarification", reason: "confirm_service" },
      view: plainView(
        `Підтвердити послугу «${session.serviceAcceptance.service.name ?? session.serviceAcceptance.service.id}»?`,
        { kind: "clarification", reason: "confirm_service" },
      ),
    };
  }

  // Replacement offered → cancel existing before create.
  if (session.replacement?.status === "offered") {
    return emitMutationConfirm(
      session,
      {
        kind: "cancel_meeting",
        payload: { meetingId: session.replacement.meeting.id },
      },
      "cancel",
      "Скасувати існуючий запис і створити новий?",
    );
  }

  const requirement = nextBookingRequirement(session, readModels);
  switch (requirement) {
    case "service":
      return {
        tag: "ask",
        session,
        pendingDecision: { kind: "clarification", reason: "need_service" },
        view: plainView("Яку послугу бажаєте записати?", {
          kind: "clarification",
          reason: "need_service",
        }),
      };
    case "date":
    case "time": {
      const { session: next, pendingEffect } = withPendingEffect(session, {
        kind: "present_availability",
        queryKind: session.selectedDate != null ? "exact" : "nearest",
        ...(session.selectedDate != null ? { date: session.selectedDate } : {}),
        ...(session.requestedTime != null ? { preferredTime: session.requestedTime.value } : {}),
      });
      return { tag: "effect", session: next, pendingEffect };
    }
    case "note":
      return {
        tag: "ask",
        session: {
          ...session,
          note: { ...session.note, status: "awaiting" },
          pendingDecision: null,
        },
        pendingDecision: { kind: "clarification", reason: "need_note" },
        view: plainView("Додайте примітку до візиту або пропустіть.", {
          kind: "visit_note",
          skipLabel: "Пропустити",
        }),
      };
    case "details":
      return decideContactDetails(session, readModels);
    case "ready": {
      if (session.mode === "reschedule" && session.rescheduleTarget != null && session.selectedSlot) {
        return emitMutationConfirm(
          session,
          {
            kind: "reschedule_meeting",
            payload: {
              meetingId: session.rescheduleTarget.id,
              dateStart: session.selectedSlot.dateStart,
              dateEnd: session.selectedSlot.dateEnd,
            },
          },
          "reschedule",
          "Підтвердити перенесення?",
        );
      }
      if (
        session.serviceAcceptance?.status === "accepted"
        && session.selectedSlot
        && session.contact.contactId != null
      ) {
        return emitMutationConfirm(
          session,
          {
            kind: "create_meeting",
            payload: {
              serviceId: session.serviceAcceptance.service.id,
              contactId: session.contact.contactId,
              dateStart: session.selectedSlot.dateStart,
              dateEnd: session.selectedSlot.dateEnd,
              ...(session.note.value ? { description: session.note.value } : {}),
            },
          },
          "create",
          "Підтвердити запис?",
        );
      }
      return {
        tag: "ask",
        session,
        pendingDecision: { kind: "clarification", reason: "ready_missing_prereq" },
        view: plainView("Потрібні додаткові дані для запису."),
      };
    }
    case "confirming":
      return {
        tag: "ask",
        session,
        pendingDecision: session.pendingDecision ?? {
          kind: "mutation_confirm",
          action: "create",
          effectId: session.pendingEffect?.id ?? "pending",
        },
        view: plainView("Очікую підтвердження."),
      };
    default:
      return {
        tag: "reply",
        session,
        view: plainView("Чим ще допомогти з записом?"),
      };
  }
};

const applySemanticPatch = (
  session: BookingSessionV2,
  patch: UnderstoodBookingTurn,
  readModels: BookingReadModels,
): BookingDecision => {
  if (patch.controlIntent != null) {
    switch (patch.controlIntent.kind) {
      case "main_menu":
        return applyControl(session, "menu");
      case "abandon":
        return applyControl(session, "abandon");
      case "human_handoff":
        return applyControl(session, "handoff");
      case "hitl_yes":
      case "hitl_no": {
        if (session.pendingDecision?.kind !== "mutation_confirm") {
          return {
            tag: "ask",
            session: bump(session),
            pendingDecision: { kind: "clarification", reason: "no_pending_hitl" },
            view: plainView("Немає активного підтвердження."),
          };
        }
        if (patch.controlIntent.kind === "hitl_no") {
          return {
            tag: "terminal",
            session: null,
            view: plainView("Добре, скасовую підтвердження."),
            reason: "abandon",
          };
        }
        return decideFromRequirement(session, readModels);
      }
      case "visit_status":
        return {
          tag: "reply",
          session,
          view: plainView("Перевіряю статус візиту…"),
        };
      case "return_to_booking":
        return decideFromRequirement(
          { ...session, pendingDecision: null },
          readModels,
        );
      default:
        break;
    }
  }

  let next = session;

  if (patch.serviceIntent?.kind === "confirm_pending_service") {
    if (next.serviceAcceptance?.status === "pending") {
      next = {
        ...next,
        serviceAcceptance: {
          ...next.serviceAcceptance,
          status: "accepted",
        },
        pendingDecision: null,
      };
    }
  } else if (patch.serviceIntent?.kind === "decline_pending_service") {
    next = {
      ...next,
      serviceAcceptance: null,
      pendingDecision: null,
    };
  } else if (patch.serviceIntent?.kind === "named_procedure" && patch.serviceIntent.serviceId) {
    next = {
      ...next,
      serviceAcceptance: {
        status: "accepted",
        service: {
          id: patch.serviceIntent.serviceId,
          name: patch.serviceIntent.query,
          source: "catalog",
        },
      },
      selectedDate: null,
      selectedSlot: null,
      pendingCommand: null,
      pendingDecision: null,
    };
  } else if (patch.serviceIntent?.kind === "consultation") {
    next = {
      ...next,
      serviceAcceptance: {
        status: "pending",
        service: { id: "consultation", name: "Консультація", source: "catalog" },
      },
      pendingDecision: null,
    };
  }

  if (patch.scheduleIntent?.kind === "date" || patch.scheduleIntent?.kind === "date_and_time") {
    next = {
      ...next,
      selectedDate: patch.scheduleIntent.date,
      selectedSlot: null,
      requestedTime:
        patch.scheduleIntent.kind === "date_and_time"
          ? { value: patch.scheduleIntent.time, status: "pending" }
          : next.requestedTime,
      pendingCommand: null,
    };
  } else if (patch.scheduleIntent?.kind === "time") {
    next = {
      ...next,
      requestedTime: { value: patch.scheduleIntent.time, status: "pending" },
      pendingCommand: null,
    };
  }

  if (patch.note?.kind === "skip") {
    next = { ...next, note: { status: "skipped" } };
  } else if (patch.note?.kind === "answer") {
    next = { ...next, note: { status: "answered", value: patch.note.value } };
  }

  if (patch.contactFacts != null) {
    const phoneChanged =
      patch.contactFacts.phoneNumber != null
      && patch.contactFacts.phoneNumber !== next.contact.phoneNumber;
    next = {
      ...next,
      contact: {
        ...next.contact,
        ...patch.contactFacts,
        // New phone invalidates prior lookup evidence.
        ...(phoneChanged ? { phoneLookup: null, contactId: null } : {}),
      },
    };
  }

  // Informational question is read-only: do not clear accepted facts.
  if (patch.informationalQuestion != null && Object.keys(patch).length === 1) {
    const { session: withEffect, pendingEffect } = withPendingEffect(next, {
      kind: "get_working_time",
    });
    return {
      tag: "effect",
      session: withEffect,
      pendingEffect,
    };
  }

  return decideFromRequirement(bump(next), readModels);
};

/**
 * Pure booking decision kernel (DDD-274).
 * No BaseMessage / Command / node names / prompts / lastHandoff.
 * PendingEffect correlation uses session.pendingEffect (not an external arg).
 */
export const decideBooking = (
  session: BookingSessionV2,
  input: BookingInput,
  readModels: BookingReadModels,
): BookingDecision => {
  switch (input.source) {
    case "control":
      return applyControl(session, input.intent);
    case "effect_result":
      return applyEffectResult(session, input.result);
    case "semantic_patch":
      return applySemanticPatch(session, input.patch, readModels);
    case "patient_turn":
      if (input.rawText.trim().length === 0) {
        return decideFromRequirement(session, readModels);
      }
      return {
        tag: "ask",
        session,
        pendingDecision: { kind: "clarification", reason: "needs_interpreter" },
        view: plainView("Уточніть, будь ласка, ваш запит."),
      };
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
};
