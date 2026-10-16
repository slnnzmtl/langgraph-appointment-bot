import { Overwrite } from "@langchain/langgraph";

import type { ServicesContext } from "../../../tools/service-tools.js";
import type { ClassifyContactNameTurn } from "../../contact-name-classifier.js";
import type {
  PartitionServiceCandidates,
  SelectServiceCandidates,
} from "../../service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import { stripToolNoiseFromMessages } from "../../supervisor-history.js";
import { BOOKING_AGENT_ID, FAQ_AGENT_ID } from "../../types.js";
import { applyBookingPrepareTurn } from "./booking.js";
import { applyFaqPrepareTurn } from "./faq.js";

export type CreateAgentPrepareOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  /** LLM catalog filter for free-text slang («ботокс») that lexical matching misses. */
  selectCandidates?: SelectServiceCandidates;
  /** Fetch the CRM catalog when «Обрати іншу процедуру» arrives before any list_services. */
  loadServices?: () => Promise<ServicesContext | null>;
  /** Classify first/last name replies while contact_field is open (booking). */
  classifyContactName?: ClassifyContactNameTurn;
};

export const createAgentPrepareNode = (
  agentId: string,
  options?: CreateAgentPrepareOptions,
) =>
  async (state: ClinicState): Promise<ClinicStateUpdate> => {
    const update: ClinicStateUpdate = {
      agentMessages: new Overwrite(stripToolNoiseFromMessages(state.messages)),
      stepCount: 0,
    };
    if (agentId === FAQ_AGENT_ID) {
      await applyFaqPrepareTurn(state, update, options);
    }
    if (agentId === BOOKING_AGENT_ID) {
      await applyBookingPrepareTurn(state, update, options);
    }
    return update;
  };
