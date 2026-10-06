import type { ILLMConnector } from "./types.js";
import {
  noteTurnClassificationSchema,
  type ClassifyNoteTurn,
  type NoteTurnClassification,
} from "./booking-note-turn.js";

const CLASSIFIER_SYSTEM = `You classify one patient reply during the optional visit-note step of a clinic booking.

Return exactly one kind:
- note_provided — the text is a genuine visit note / concern / area detail (keep the selected service)
- note_skipped — the patient declines to leave a note
- service_change_requested — the patient explicitly asks to book or switch to a different service
- service_or_note_clarification_required — the text could be either a note or a request to change service
- schedule_change_requested — the patient asks to change the day or time (without a grounded snapshot match)
- leave_booking — only for an unambiguous request to leave booking (rare; prefer unresolved)
- unresolved — cannot classify safely

Rules:
- Never invent a CRM service id.
- Optional query is a short service-referring span from the patient text, not a paraphrase of the whole message.
- Do not return a note value or rewritten sentence.
- Ukrainian and English are both valid.`;

export const createNoteTurnClassifier = (llm: ILLMConnector): ClassifyNoteTurn => {
  const chain = llm.bindRoutingTools(
    noteTurnClassificationSchema,
    { name: "classify_booking_note_turn" },
  );

  return async ({ patientText, currentServiceName }) => {
    const serviceLine = currentServiceName != null && currentServiceName.trim().length > 0
      ? `Current accepted service: ${currentServiceName}`
      : "Current accepted service: (unknown)";
    const result = await chain.invoke([
      { role: "system", content: CLASSIFIER_SYSTEM },
      {
        role: "user",
        content: `${serviceLine}\nPatient message:\n${patientText}`,
      },
    ]);
    return result as NoteTurnClassification;
  };
};
