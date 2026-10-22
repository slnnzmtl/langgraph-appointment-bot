import type { ServicesContext } from "../../../tools/service-tools.js";
import type {
  PartitionServiceCandidates,
  SelectServiceCandidates,
} from "../../service-resolution.js";
import type { ClinicState, ClinicStateUpdate } from "../../state.js";
import { stripToolNoiseFromMessages } from "../../supervisor-history.js";
import { Overwrite } from "@langchain/langgraph";
import { isReplaceCancelCreateDraft, prepareFaqTurn } from "./faq.js";

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
  async (state: ClinicState): Promise<ClinicStateUpdate> => {
    const faqUpdate = await prepareFaqTurn(state, options);
    // REPLACE cancel continue: keep cancel_meeting ToolMessage so FAQ finalize
    // can prefix «Запис скасовано.» (wipe would erase the committed ack).
    const keepCancelTape = isReplaceCancelCreateDraft(state);
    return {
      ...(keepCancelTape ? { stepCount: 0 } : wipeAgentTape(state)),
      ...faqUpdate,
    };
  };
