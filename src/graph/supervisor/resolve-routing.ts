import { AIMessage } from "@langchain/core/messages";

import { trackEvent } from "../../analytics/track.js";
import {
  defaultMenuLabels,
  PATIENT_FALLBACK_MESSAGE,
  VISIT_CHANGE_MENU,
} from "../../shared/clinic-constants.js";
import { extractReplyButtons } from "../../shared/message-content.js";
import {
  attachPrefetchVisits,
  type FinishVisitIntent,
} from "../context-blocks.js";
import {
  normalizeSupervisorReply,
  type ClinicRoutingDecision,
} from "../routing.js";
import type { ClinicState, ClinicStateUpdate } from "../state.js";
import { FINISH_ROUTE } from "../types.js";
import {
  isGreetingOrMainMenuLine,
  lastHumanLineFromMessages,
} from "./routing-predicates.js";
import { isVisitStatusSignal } from "./visit-status.js";

export const routingFailureUpdate = (reason: string): ClinicStateUpdate => {
  console.error("[clinic-supervisor] routing failure:", reason);
  return {
    next: FINISH_ROUTE,
    lastHandoff: {
      agentId: FINISH_ROUTE,
      agentName: "supervisor",
      status: "error",
      replyText: PATIENT_FALLBACK_MESSAGE,
      replyButtons: [...defaultMenuLabels(false)],
    },
  };
};

export const resolveRoutingDecision = (
  decision: ClinicRoutingDecision,
  state: ClinicState,
  enabledIds: Set<string>,
  bookingContext: ClinicState["bookingContext"],
): ClinicStateUpdate => {
  if (decision.next === FINISH_ROUTE) {
    const hasVisit = (bookingContext?.meetings.length ?? 0) > 0;
    const lastHumanLine = lastHumanLineFromMessages(state.messages);
    const wantsVisitChange = hasVisit && isVisitStatusSignal(lastHumanLine);

    const normalizedReply = normalizeSupervisorReply(decision.reply);
    if (!normalizedReply) {
      const last = state.messages[state.messages.length - 1];
      if (last instanceof AIMessage && state.lastHandoff) {
        return {
          next: FINISH_ROUTE,
          lastHandoff: null,
        };
      }
      if (!wantsVisitChange) {
        return routingFailureUpdate("FINISH without reply");
      }
    }

    const text = normalizedReply ? extractReplyButtons(normalizedReply).text : "";
    const visitIntent: FinishVisitIntent = wantsVisitChange
      ? "visit_ask"
      : isGreetingOrMainMenuLine(lastHumanLine)
        ? "greeting"
        : "other";
    const replyText = attachPrefetchVisits(text, bookingContext, visitIntent);
    let replyButtons: string[];
    if (wantsVisitChange) {
      replyButtons = [...VISIT_CHANGE_MENU];
      if (decision.menu == null) {
        trackEvent("reply_menu_filled", { menu: "visit_change", reason: "omitted" });
      }
    } else {
      replyButtons = [...defaultMenuLabels(hasVisit)];
    }

    return {
      next: FINISH_ROUTE,
      lastHandoff: {
        agentId: FINISH_ROUTE,
        agentName: "supervisor",
        status: "ok",
        replyText,
        replyButtons,
      },
      messages: [new AIMessage(replyText)],
    };
  }

  if (!enabledIds.has(decision.next)) {
    return routingFailureUpdate(`Unknown route: ${decision.next}`);
  }

  return {
    next: decision.next,
    lastHandoff: null,
  };
};
