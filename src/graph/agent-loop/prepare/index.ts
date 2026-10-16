import { Overwrite } from "@langchain/langgraph";

import type { ServicesContext } from "../../../tools/service-tools.js";
import type { ClassifyContactNameTurn } from "../../contact-name-classifier.js";
import type {
  PartitionServiceCandidates,
  SelectServiceCandidates,
} from "../../service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import { stripToolNoiseFromMessages } from "../../supervisor-history.js";
import { prepareBookingTurn } from "./booking.js";
import { prepareFaqTurn } from "./faq.js";

export type CreateFaqPrepareOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  /** LLM catalog filter for free-text slang («ботокс») that lexical matching misses. */
  selectCandidates?: SelectServiceCandidates;
  /** Fetch the CRM catalog when «Обрати іншу процедуру» arrives before any list_services. */
  loadServices?: () => Promise<ServicesContext | null>;
};

export type CreateBookingPrepareOptions = {
  /** Classify first/last name replies while contact_field is open. */
  classifyContactName?: ClassifyContactNameTurn;
};

/** Wipe prior agent tape and reset step count for a fresh prepare turn. */
const wipeAgentTape = (state: ClinicState): ClinicStateUpdate => ({
  agentMessages: new Overwrite(stripToolNoiseFromMessages(state.messages)),
  stepCount: 0,
});

export const createFaqPrepareNode = (
  options?: CreateFaqPrepareOptions,
) =>
  async (state: ClinicState): Promise<ClinicStateUpdate> => ({
    ...wipeAgentTape(state),
    ...await prepareFaqTurn(state, options),
  });

export const createBookingPrepareNode = (
  options?: CreateBookingPrepareOptions,
) =>
  async (state: ClinicState): Promise<ClinicStateUpdate> => ({
    ...wipeAgentTape(state),
    ...await prepareBookingTurn(state, {
      ...(options?.classifyContactName != null
        ? { classifyContactName: options.classifyContactName }
        : {}),
    }),
  });
