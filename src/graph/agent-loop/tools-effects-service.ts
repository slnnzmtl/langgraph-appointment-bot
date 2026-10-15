import type { BaseMessage } from "@langchain/core/messages";
import type { ClinicStateUpdate } from "../state.js";
import { captureServicesFromMessages } from "./protocol.js";

export const projectServiceEffects = (input: {
  resultMessages: BaseMessage[];
}): ClinicStateUpdate => {
  const capturedServices = captureServicesFromMessages(input.resultMessages);
  if (capturedServices === undefined) {
    return {};
  }
  return { servicesContext: capturedServices };
};
