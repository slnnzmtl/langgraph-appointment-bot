import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { trackEvent, trackToolError } from "../../analytics/track.js";
import { normalizeClinicPhone } from "../../shared/phone.js";
import {
  presentAvailabilitySlotsArgsSchema,
  tryAvailabilityCacheHit,
} from "../../tools/availability-tools.js";
import { isBookingRuntimeToolName } from "../../tools/index.js";
import {
  bookingDraftCanPresentAvailability,
  effectiveBookingContactDetails,
  type BookingContactField,
} from "../booking-draft.js";
import {
  createContactPhoneMatchesOccupiedCandidate,
  phoneCandidateCanBeLinked,
  resolveContactIdentity,
} from "../contact-command.js";
import type { ClinicState } from "../state.js";
import { BOOKING_AGENT_ID } from "../types.js";
import {
  authoritativeSelectedSlot,
  freshAvailabilityValidatesSelectedSlot,
  isPendingChatConfirmationReplay,
  isRuntimeOriginatedToolAi,
} from "./booking-command.js";
import {
  CONTACT_LINK_CANDIDATE_REQUIRED_ERROR,
  CONTACT_OWNERSHIP_REQUIRED_ERROR,
  NAME_NOT_PROVIDED_ERROR,
  PHONE_GROUNDED_TOOLS,
  PHONE_NOT_PROVIDED_ERROR,
  blocksConsultationWithoutAgreement,
  humanProvidedName,
  humanProvidedPhone,
  normalizeNameForMatch,
} from "./protocol.js";

export type ToolRecovery =
  | { type: "service_confirmation_required" }
  | {
      type: "contact_field_required";
      field: BookingContactField;
      occupied?: boolean;
    };

export type ToolProtocolResult = {
  messagesForTools: BaseMessage[];
  syntheticMessages: ToolMessage[];
  stateTapeRewrite?: BaseMessage[];
  recovery: ToolRecovery | null;
};

const rewriteAiToolCalls = (
  agentMessages: BaseMessage[],
  lastAiIndex: number,
  remainingCalls: NonNullable<AIMessage["tool_calls"]>,
): BaseMessage[] => {
  if (lastAiIndex < 0) {
    return agentMessages;
  }
  const lastAi = agentMessages[lastAiIndex] as AIMessage;
  const originalCalls = lastAi.tool_calls ?? [];
  if (remainingCalls.length === originalCalls.length) {
    return agentMessages;
  }
  return [
    ...agentMessages.slice(0, lastAiIndex),
    new AIMessage({
      content: lastAi.content,
      tool_calls: remainingCalls,
      additional_kwargs: lastAi.additional_kwargs,
      response_metadata: lastAi.response_metadata,
      id: lastAi.id,
    } as ConstructorParameters<typeof AIMessage>[0]),
    ...agentMessages.slice(lastAiIndex + 1),
  ];
};

export const filterToolTape = (
  state: ClinicState,
  agentId?: string,
): ToolProtocolResult => {
    const agentMessages = state.agentMessages ?? [];
    let lastAiIndex = -1;
    for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
      const message = agentMessages[index];
      if (message instanceof AIMessage && (message.tool_calls?.length ?? 0) > 0) {
        lastAiIndex = index;
        break;
      }
    }

    const synthetic: ToolMessage[] = [];
    const remainingCalls: NonNullable<AIMessage["tool_calls"]> = [];
    let strippedUnstampedRuntime = false;
    let consultationAgreementStrip = false;
    let contactRecoveryStrip: "ownership" | "link_candidate" | null = null;

    if (lastAiIndex >= 0) {
      const lastAi = agentMessages[lastAiIndex] as AIMessage;
      const runtimeOriginOk = agentId === BOOKING_AGENT_ID
        ? isRuntimeOriginatedToolAi(lastAi)
        : true;

      for (const call of lastAi.tool_calls ?? []) {
        // Legacy checkpoints may still hold model-originated runtime calls.
        // Fail closed: do not execute unstamped runtime-owned tools.
        if (
          agentId === BOOKING_AGENT_ID
          && isBookingRuntimeToolName(call.name)
          && !runtimeOriginOk
        ) {
          trackToolError(call.name, "unstamped_runtime_tool");
          strippedUnstampedRuntime = true;
          continue;
        }

        // Defense in depth: ContactCommand builds args; still refuse invented
        // phone/name values if a stamped call somehow carries them.
        if (PHONE_GROUNDED_TOOLS.has(call.name)) {
          const openCollected = state.pendingInteraction?.kind === "contact_field"
            ? state.pendingInteraction.collected
            : undefined;
          const canonicalIdentity = effectiveBookingContactDetails({
            contactDetails: state.bookingDraft?.contactDetails ?? null,
            ...(openCollected != null ? { collected: openCollected } : {}),
          });
          const rawPhone = (call.args ?? {}).phoneNumber;
          if (typeof rawPhone === "string" && rawPhone.trim() !== "") {
            const wanted = normalizeClinicPhone(rawPhone);
            const acceptedPhone = canonicalIdentity.phoneNumber != null
              ? normalizeClinicPhone(canonicalIdentity.phoneNumber)
              : null;
            if (
              wanted != null
              && !humanProvidedPhone(state.messages ?? [], wanted)
              && acceptedPhone !== wanted
            ) {
              trackToolError(call.name, PHONE_NOT_PROVIDED_ERROR);
              synthetic.push(
                new ToolMessage({
                  content: JSON.stringify({
                    error: PHONE_NOT_PROVIDED_ERROR,
                    field: "phoneNumber",
                    hint:
                      "Ask the patient for their clinic phone, then retry with the number they typed.",
                  }),
                  tool_call_id: call.id ?? "",
                  name: call.name,
                }),
              );
              continue;
            }
          }

          if (call.name === "create_contact" || call.name === "update_contact") {
            const args = call.args ?? {};
            const nameFields = ["firstName", "lastName"] as const;
            const invented = nameFields.find((field) => {
              const raw = args[field];
              const accepted = canonicalIdentity[field];
              return (
                typeof raw === "string"
                && raw.trim() !== ""
                && !humanProvidedName(state.messages ?? [], raw)
                && !(
                  typeof accepted === "string"
                  && normalizeNameForMatch(accepted) === normalizeNameForMatch(raw)
                )
              );
            });
            if (invented) {
              trackToolError(call.name, NAME_NOT_PROVIDED_ERROR);
              synthetic.push(
                new ToolMessage({
                  content: JSON.stringify({
                    error: NAME_NOT_PROVIDED_ERROR,
                    field: invented,
                    hint:
                      "Ask the patient for their name, then retry with the value they typed.",
                  }),
                  tool_call_id: call.id ?? "",
                  name: call.name,
                }),
              );
              continue;
            }
          }

          if (
            call.name === "create_contact"
            && createContactPhoneMatchesOccupiedCandidate(
              resolveContactIdentity(state.contactContext),
              (call.args ?? {}).phoneNumber,
            )
          ) {
            // Fail closed — occupied phone keyboard owns recovery.
            trackToolError(call.name, CONTACT_LINK_CANDIDATE_REQUIRED_ERROR);
            strippedUnstampedRuntime = true;
            contactRecoveryStrip = "link_candidate";
            continue;
          }
        }

        if (call.name === "present_availability_slots") {
          if (!bookingDraftCanPresentAvailability(state.bookingDraft)) {
            trackToolError(call.name, "Availability requires accepted service");
            strippedUnstampedRuntime = true;
            continue;
          }
          const parsed = presentAvailabilitySlotsArgsSchema.safeParse(call.args ?? {});
          if (!parsed.success) {
            trackToolError(call.name, "Invalid availability arguments");
            synthetic.push(
              new ToolMessage({
                content: JSON.stringify({
                  error: "Invalid availability arguments",
                  hint:
                    "Use YYYY-MM-DD for date/afterDate/beforeDate/startDate; durationMinutes 15–180.",
                }),
                tool_call_id: call.id ?? "",
                name: call.name,
              }),
            );
            continue;
          }
          call.args = parsed.data;
          if (parsed.data.direction === "exact" && !parsed.data.date) {
            trackToolError(call.name, "Exact availability date missing");
            synthetic.push(
              new ToolMessage({
                content: JSON.stringify({
                  error: "Exact availability date missing",
                  hint: "Resolve the patient's named calendar date before searching availability.",
                }),
                tool_call_id: call.id ?? "",
                name: "present_availability_slots",
              }),
            );
            continue;
          }
          const hit = tryAvailabilityCacheHit(state.availabilityContext, parsed.data);
          if (hit) {
            trackEvent("availability_cache_hit", {
              outcome: "success",
              kind: hit.kind,
              ...(typeof parsed.data.date === "string" ? { date: parsed.data.date } : {}),
            });
            synthetic.push(
              new ToolMessage({
                content: hit.json,
                tool_call_id: call.id ?? "",
                name: "present_availability_slots",
              }),
            );
            continue;
          }
        }

        if (
          (call.name === "create_meeting" || call.name === "reschedule_meeting")
          && blocksConsultationWithoutAgreement(agentId, call, state)
        ) {
          trackEvent("booking_consultation_guard", {
            phase: state.bookingDraft?.phase ?? "service",
            outcome: "blocked",
          });
          strippedUnstampedRuntime = true;
          consultationAgreementStrip = true;
          continue;
        }

        // Defense in depth: ownership missing → strip; contact_field owns recovery.
        if (
          call.name === "create_meeting"
          && resolveContactIdentity(
            state.contactContext,
            state.bookingDraft?.contactId,
          ).kind !== "owned"
        ) {
          trackToolError(call.name, CONTACT_OWNERSHIP_REQUIRED_ERROR);
          strippedUnstampedRuntime = true;
          contactRecoveryStrip = "ownership";
          continue;
        }

        if (call.name === "create_meeting" || call.name === "reschedule_meeting") {
          const action = call.name === "create_meeting" ? "create" : "reschedule";
          const chatConfirmationReplay = isPendingChatConfirmationReplay(
            state,
            action,
            call.args,
          );
          const requiresFresh = state.bookingDraft?.pendingCommand?.action === action
            && !chatConfirmationReplay;
          if (requiresFresh && !freshAvailabilityValidatesSelectedSlot(state)) {
            trackToolError(call.name, "Selected slot is no longer available");
            strippedUnstampedRuntime = true;
            continue;
          }
          const selected = authoritativeSelectedSlot(state);
          const args = (call.args ?? {}) as Record<string, unknown>;
          if (
            selected != null
            && !chatConfirmationReplay
            && typeof args.dateStart === "string"
            && typeof args.dateEnd === "string"
            && (
              args.dateStart !== selected.dateStart
              || args.dateEnd !== selected.dateEnd
            )
          ) {
            trackToolError(call.name, "Selected slot is no longer available");
            strippedUnstampedRuntime = true;
            continue;
          }
          if (
            call.name === "reschedule_meeting"
            && (
              state.bookingDraft?.mode !== "reschedule"
              || state.bookingDraft.rescheduleTarget == null
              || state.bookingDraft.selectedSlot == null
              || state.bookingDraft.pendingCommand?.action !== "reschedule"
            )
            && !chatConfirmationReplay
          ) {
            trackToolError(call.name, "Reschedule state required");
            strippedUnstampedRuntime = true;
            continue;
          }
        }

        if (call.name === "link_telegram_to_contact") {
          const args = call.args;
          const contactId = args && typeof args === "object" && !Array.isArray(args)
            && typeof (args as { contactId?: unknown }).contactId === "string"
            ? (args as { contactId: string }).contactId
            : null;
          if (
            contactId == null
            || !phoneCandidateCanBeLinked(resolveContactIdentity(state.contactContext), contactId)
          ) {
            // Fail closed — occupied phone keyboard owns recovery.
            trackToolError(call.name, CONTACT_LINK_CANDIDATE_REQUIRED_ERROR);
            strippedUnstampedRuntime = true;
            contactRecoveryStrip = "link_candidate";
            continue;
          }
        }

        remainingCalls.push(call);
      }

      // Drop unstamped runtime calls from the AI message so the tape stays
      // protocol-valid without synthetic invariant ToolMessages.
      if (
        strippedUnstampedRuntime
        && remainingCalls.length === 0
        && synthetic.length === 0
      ) {
        const lastAi = agentMessages[lastAiIndex] as AIMessage;
        const kept = (lastAi.tool_calls ?? []).filter(
          (call) => !isBookingRuntimeToolName(call.name),
        );
        const rewritten = [
            ...agentMessages.slice(0, lastAiIndex),
            new AIMessage({
              content: lastAi.content,
              tool_calls: kept,
              additional_kwargs: lastAi.additional_kwargs,
              response_metadata: lastAi.response_metadata,
              id: lastAi.id,
            } as ConstructorParameters<typeof AIMessage>[0]),
            ...agentMessages.slice(lastAiIndex + 1),
          ];
        const recovery: ToolRecovery | null = consultationAgreementStrip
          ? { type: "service_confirmation_required" }
          : contactRecoveryStrip != null
            ? {
                type: "contact_field_required",
                field: "phoneNumber",
                occupied: contactRecoveryStrip === "link_candidate",
              }
            : null;
        return {
          messagesForTools: rewritten,
          syntheticMessages: [],
          stateTapeRewrite: rewritten,
          recovery,
        };
      }
    }


    return {
      messagesForTools: rewriteAiToolCalls(agentMessages, lastAiIndex, remainingCalls),
      syntheticMessages: synthetic,
      recovery: null,
    };
};
