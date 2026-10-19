import type { BookingDecision, BookingInput, BookingReadModels, BookingView } from "./decision.js";
import type { BookingEffect, EffectResult, PendingEffect } from "./effects.js";
import { nextBookingRequirement } from "./requirement.js";
import type { BookingSessionV2 } from "./session.js";
import type { UnderstoodBookingTurn } from "./turn.js";

const plainView = (replyText: string, card: BookingView["card"] = null): BookingView => ({
  replyText,
  card,
});

const bump = (session: BookingSessionV2): BookingSessionV2 => ({
  ...session,
  revision: session.revision + 1,
});

const withPendingEffect = (
  session: BookingSessionV2,
  effect: BookingEffect,
): { session: BookingSessionV2; pendingEffect: PendingEffect } => {
  const pendingEffect: PendingEffect = {
    id: `eff_${session.revision + 1}_${effect.kind}`,
    expectedRevision: session.revision + 1,
    effect,
    status: "prepared",
  };
  return {
    session: {
      ...bump(session),
      pendingEffect: null, // lifecycle field reserved; correlation lives on decision
      pendingCommand:
        effect.kind === "create_meeting"
        || effect.kind === "reschedule_meeting"
        || effect.kind === "cancel_meeting"
          ? {
              action:
                effect.kind === "create_meeting"
                  ? "create"
                  : effect.kind === "reschedule_meeting"
                    ? "reschedule"
                    : "cancel",
              payload: { ...effect.payload, effectId: pendingEffect.id },
            }
          : session.pendingCommand,
    },
    pendingEffect,
  };
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

const applyEffectResult = (
  session: BookingSessionV2,
  result: EffectResult,
  pending: PendingEffect | null,
): BookingDecision => {
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
      // Never blind-replay a write with unknown outcome — require fresh CRM verification.
      return {
        tag: "effect",
        ...(() => {
          const effect: BookingEffect = { kind: "get_working_time" };
          // Use a read effect as stand-in for "verify" in the closed union; adapters
          // map this to prefetch/ownership refresh before any mutation retry.
          return withPendingEffect(
            {
              ...session,
              pendingCommand: null,
              pendingDecision: { kind: "clarification", reason: "mutation_outcome_unknown" },
              selectedSlot: session.selectedSlot == null
                ? null
                : { ...session.selectedSlot, provenance: "unverified_legacy" },
            },
            effect,
          );
        })(),
      };
    }
    if (result.outcome === "committed") {
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
      session: {
        ...bump(session),
        pendingCommand: null,
        pendingDecision: null,
      },
      view: plainView("Не вдалося змінити запис. Спробуйте ще раз."),
    };
  }
  if (result.kind === "availability") {
    if (result.outcome === "stale" || result.outcome === "error") {
      const next = {
        ...session,
        selectedSlot: session.selectedSlot == null
          ? null
          : { ...session.selectedSlot, provenance: "unverified_legacy" as const },
        pendingCommand: null,
      };
      return decideFromRequirement(bump(next), { contactContextDirty: false, bookingContextDirty: false, availabilityVerified: false });
    }
    if (result.outcome === "empty" || result.outcome === "closed") {
      return {
        tag: "ask",
        session: bump(session),
        pendingDecision: { kind: "clarification", reason: "availability_empty" },
        view: plainView("На цей час немає вільних слотів. Оберіть іншу дату."),
      };
    }
    return decideFromRequirement(
      bump({
        ...session,
        selectedSlot: session.selectedSlot == null
          ? null
          : { ...session.selectedSlot, provenance: "availability_tool" },
      }),
      { contactContextDirty: false, bookingContextDirty: false, availabilityVerified: true },
    );
  }
  if (result.kind === "contact_lookup") {
    const contact = { ...session.contact };
    if (result.outcome === "single_linkable" && result.contactIds?.[0]) {
      contact.contactId = result.contactIds[0];
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
      bump({ ...session, contact }),
      { contactContextDirty: false, bookingContextDirty: false, availabilityVerified: true },
    );
  }
  return decideFromRequirement(bump(session), {
    contactContextDirty: false,
    bookingContextDirty: false,
    availabilityVerified: true,
  });
};

const decideFromRequirement = (
  session: BookingSessionV2,
  readModels: BookingReadModels,
): BookingDecision => {
  if (session.pendingDecision?.kind === "mutation_confirm" && session.pendingCommand != null) {
    const action = session.pendingDecision.action;
    const effectKind =
      action === "create"
        ? "create_meeting" as const
        : action === "reschedule"
          ? "reschedule_meeting" as const
          : "cancel_meeting" as const;
    const { session: next, pendingEffect } = withPendingEffect(session, {
      kind: effectKind,
      payload: { ...session.pendingCommand.payload },
    });
    return {
      tag: "mutation_confirm",
      session: {
        ...next,
        pendingDecision: session.pendingDecision,
      },
      pendingEffect,
      view: plainView(
        action === "cancel" ? "Підтвердити скасування?" : "Підтвердити запис?",
        {
          kind: "mutation_confirm",
          action,
          effectId: pendingEffect.id,
        },
      ),
    };
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
    case "details": {
      const field =
        session.contact.phoneNumber == null
          ? "phoneNumber" as const
          : session.contact.firstName == null
            ? "firstName" as const
            : "lastName" as const;
      if (field === "phoneNumber" && session.contact.phoneNumber != null) {
        const { session: next, pendingEffect } = withPendingEffect(session, {
          kind: "lookup_contact_by_phone",
          phoneNumber: session.contact.phoneNumber,
        });
        return { tag: "effect", session: next, pendingEffect };
      }
      return {
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
      };
    }
    case "ready": {
      if (session.mode === "reschedule" && session.rescheduleTarget != null && session.selectedSlot) {
        const { session: next, pendingEffect } = withPendingEffect(session, {
          kind: "reschedule_meeting",
          payload: {
            meetingId: session.rescheduleTarget.id,
            dateStart: session.selectedSlot.dateStart,
            dateEnd: session.selectedSlot.dateEnd,
          },
        });
        return {
          tag: "mutation_confirm",
          session: {
            ...next,
            pendingDecision: {
              kind: "mutation_confirm",
              action: "reschedule",
              effectId: pendingEffect.id,
            },
          },
          pendingEffect,
          view: plainView("Підтвердити перенесення?", {
            kind: "mutation_confirm",
            action: "reschedule",
            effectId: pendingEffect.id,
          }),
        };
      }
      if (
        session.serviceAcceptance?.status === "accepted"
        && session.selectedSlot
        && session.contact.contactId != null
      ) {
        const { session: next, pendingEffect } = withPendingEffect(session, {
          kind: "create_meeting",
          payload: {
            serviceId: session.serviceAcceptance.service.id,
            contactId: session.contact.contactId,
            dateStart: session.selectedSlot.dateStart,
            dateEnd: session.selectedSlot.dateEnd,
            ...(session.note.value ? { description: session.note.value } : {}),
          },
        });
        return {
          tag: "mutation_confirm",
          session: {
            ...next,
            pendingDecision: {
              kind: "mutation_confirm",
              action: "create",
              effectId: pendingEffect.id,
            },
          },
          pendingEffect,
          view: plainView("Підтвердити запис?", {
            kind: "mutation_confirm",
            action: "create",
            effectId: pendingEffect.id,
          }),
        };
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
          effectId: "pending",
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
        // Affirm: emit the frozen mutation effect once.
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
  if (patch.serviceIntent?.kind === "named_procedure" && patch.serviceIntent.serviceId) {
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
    next = {
      ...next,
      contact: {
        ...next.contact,
        ...patch.contactFacts,
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
 */
export const decideBooking = (
  session: BookingSessionV2,
  input: BookingInput,
  readModels: BookingReadModels,
  pendingEffect: PendingEffect | null = null,
): BookingDecision => {
  switch (input.source) {
    case "control":
      return applyControl(session, input.intent);
    case "effect_result":
      return applyEffectResult(session, input.result, pendingEffect);
    case "semantic_patch":
      return applySemanticPatch(session, input.patch, readModels);
    case "patient_turn":
      // Phase 4 owns structured interpretation; Phase 2 fails closed to clarification
      // unless the turn is empty (progress from requirement alone).
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
