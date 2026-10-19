import type { ServicesContext } from "../../../tools/service-tools.js";
import type {
  PartitionServiceCandidates,
  SelectServiceCandidates,
} from "../../service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import { stripToolNoiseFromMessages } from "../../supervisor-history.js";
import { Overwrite } from "@langchain/langgraph";
import { prepareFaqTurn } from "./faq.js";

export type CreateFaqPrepareOptions = {
  partitionCandidates?: PartitionServiceCandidates;
  /** LLM catalog filter for free-text slang («ботокс») that lexical matching misses. */
  selectCandidates?: SelectServiceCandidates;
  /** Fetch the CRM catalog when «Обрати іншу процедуру» arrives before any list_services. */
  loadServices?: () => Promise<ServicesContext | null>;
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
