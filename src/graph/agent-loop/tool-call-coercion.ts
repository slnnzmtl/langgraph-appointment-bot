import { AIMessage } from "@langchain/core/messages";

import { BOOKING_AGENT_ID } from "../types.js";
import { kyivToday } from "../../tools/availability-slots.js";
import { resolveBookingScheduleRequest } from "../booking-schedule.js";
import { trackToolError } from "../../analytics/track.js";
import {
  extractRawMessageText,
  isYesReply,
  parseLeakedModelToolCalls,
  stripLeakedModelToolCalls,
} from "../../shared/message-content.js";
import type { ClinicState } from "../state.js";

import {
  availabilitySlotsRanThisTurn,
  lastPatientText,
  matchAvailabilityDay,
  rescheduleAvailabilityArgsFromBookingContext,
} from "./shared.js";

/**
 * Sanitize model tool calls before ToolNode: drop non-allowlisted names (stale
 * native calls such as faq_catalog_action), hydrate leaked Gemini XML into
 * allowlisted calls, and inject slots when booking skipped the tool.
 */
export const coerceAvailabilityToolCalls = (
  response: AIMessage,
  state: ClinicState,
  agentId: string,
  allowedToolNames: ReadonlySet<string>,
): AIMessage => {
  const raw = extractRawMessageText(response.content);
  const leaked = parseLeakedModelToolCalls(raw).filter((call) =>
    allowedToolNames.has(call.name),
  );
  const existingRaw = response.tool_calls ?? [];
  for (const call of existingRaw) {
    if (!allowedToolNames.has(call.name)) {
      trackToolError("disallowed_tool_call", call.name);
    }
  }
  const allowlisted = existingRaw.filter((call) => allowedToolNames.has(call.name));
  let toolCalls = allowlisted;
  if (allowlisted.length === 0 && leaked.length > 0) {
    toolCalls = leaked.map((call, index) => ({
      id: `leaked_${call.name}_${index}`,
      name: call.name,
      args: call.args,
      type: "tool_call" as const,
    }));
  }
  if (
    agentId === BOOKING_AGENT_ID
    && !toolCalls.some((call) => call.name === "present_availability_slots")
  ) {
    const human = lastPatientText(state);
    const days = state.availabilityContext?.days ?? [];
    const request = resolveBookingScheduleRequest(human, kyivToday(), {
      availabilityContext: state.availabilityContext,
      availabilityCursor: state.availabilityCursor,
      selectedDate: state.bookingDraft?.selectedDate,
    });
    const dayPick = matchAvailabilityDay(human, days);
    const semanticDirection = request?.kind === "earlier" || request?.kind === "later" || request?.kind === "nearest"
      ? request.kind
      : isYesReply(human) ? "nearest" : undefined;
    // Recovery is allowed only for a structured patient action. Never turn arbitrary
    // availability-looking prose into an argument-less call that can replay a cache.
    // Pre-HITL leftover slots on the tape do not count as this turn.
    if (
      !availabilitySlotsRanThisTurn(state.agentMessages ?? [])
      && dayPick == null
      && (request != null || semanticDirection != null)
    ) {
      const args = request?.kind === "exact"
        ? { direction: "exact", date: request.date }
        : { direction: semanticDirection ?? "nearest" };
      toolCalls = [
        ...toolCalls,
        {
          id: `slots_coerce_${state.stepCount ?? 0}`,
          name: "present_availability_slots",
          args,
          type: "tool_call" as const,
        },
      ];
    }
  }

  // Rescheduling is a runtime-owned availability transition. A model may ask
  // the patient to choose a day without emitting the required tool call; when
  // the supervisor has exactly one authoritative visit, synthesize the query
  // and bind it to that visit. Multiple visits remain model/selection-driven.
  if (
    agentId === BOOKING_AGENT_ID
    && !toolCalls.some((call) => call.name === "present_availability_slots")
  ) {
    const args = rescheduleAvailabilityArgsFromBookingContext(state);
    if (args && !availabilitySlotsRanThisTurn(state.agentMessages ?? [])) {
      toolCalls = [
        ...toolCalls,
        {
          id: `slots_reschedule_${state.stepCount ?? 0}`,
          name: "present_availability_slots",
          args,
          type: "tool_call" as const,
        },
      ];
    }
  }

  const contentWasString = typeof response.content === "string";
  let nextContent: AIMessage["content"] = response.content;
  let contentChanged = false;
  if (contentWasString) {
    const original = response.content as string;
    const stripped = stripLeakedModelToolCalls(original);
    if (stripped !== original) {
      nextContent = stripped;
      contentChanged = true;
    }
  } else if (Array.isArray(response.content)) {
    const originalParts = response.content;
    const strippedParts = originalParts.map((part) => {
      if (typeof part === "string") {
        return stripLeakedModelToolCalls(part);
      }
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
        const text = String((part as { text: string }).text);
        const stripped = stripLeakedModelToolCalls(text);
        return stripped === text ? part : { ...part, text: stripped };
      }
      return part;
    });
    const partsChanged = strippedParts.some((part, index) => part !== originalParts[index]);
    if (partsChanged) {
      nextContent = strippedParts as typeof response.content;
      contentChanged = true;
    }
  } else {
    const stripped = stripLeakedModelToolCalls(raw);
    if (stripped !== raw) {
      nextContent = stripped;
      contentChanged = true;
    }
  }

  if (
    !contentChanged
    && toolCalls === allowlisted
    && allowlisted.length === existingRaw.length
  ) {
    return response;
  }

  return new AIMessage({
    content: nextContent,
    tool_calls: toolCalls,
    additional_kwargs: response.additional_kwargs,
    response_metadata: response.response_metadata,
  });
};
