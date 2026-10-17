import { type BaseMessage } from "@langchain/core/messages";
import { normalizeListServicesResult, type ServicesContext } from "../../../tools/service-tools.js";
import { CONSULTATION_SERVICE_ID } from "../../../shared/clinic-constants.js";
import { BOOKING_AGENT_ID } from "../../types.js";
import type { ClinicState } from "../../state.js";
import { captureLatestToolContext } from "./tape.js";

export const CREATE_CONSULTATION_REQUIRED_ERROR = "Consultation agreement required";

const CONSULTATION_AGREEMENT_TOOLS = new Set(["create_meeting", "reschedule_meeting"]);

const toolCallServiceId = (call: { args?: unknown }): string | null => {
  const args = call.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const serviceId = (args as { serviceId?: unknown }).serviceId;
  return typeof serviceId === "string" ? serviceId : null;
};

export const blocksConsultationWithoutAgreement = (
  agentId: string | undefined,
  call: { name: string; args?: unknown },
  state: ClinicState,
): boolean =>
  agentId === BOOKING_AGENT_ID
  && CONSULTATION_AGREEMENT_TOOLS.has(call.name)
  && toolCallServiceId(call) === CONSULTATION_SERVICE_ID
  && !(
    state.bookingDraft?.serviceAcceptance?.status === "accepted"
    && state.bookingDraft.serviceAcceptance.service.id === CONSULTATION_SERVICE_ID
  );

export const captureServicesFromMessages = (
  messages: BaseMessage[],
): ServicesContext | null | undefined =>
  captureLatestToolContext(messages, "list_services", normalizeListServicesResult);

/**
 * Prefer the checkpointed catalog; lazy-load when empty.
 * Callers assign `loaded` onto servicesContext only when non-null.
 */
export const ensureServicesContext = async (
  current: ServicesContext | null | undefined,
  loadServices?: () => Promise<ServicesContext | null>,
): Promise<{ list: ServicesContext["list"]; loaded: ServicesContext | null }> => {
  const list = current?.list ?? [];
  if (list.length > 0 || loadServices == null) {
    return { list, loaded: null };
  }
  const loaded = await loadServices().catch(() => null);
  if (loaded != null && loaded.list.length > 0) {
    return { list: loaded.list, loaded };
  }
  return { list, loaded: null };
};
