import type { ILLMConnector } from "./types.js";
import {
  noteTurnClassificationSchema,
  type ClassifyNoteTurn,
  type NoteTurnClassification,
} from "./booking-note-turn.js";

export const NOTE_TURN_CLASSIFIER_INSTRUCTION = `You classify one patient reply during the optional visit-note step of a clinic booking.

A service is already accepted. This message is answering "any details before we book?" It is not a catalog search.

Return exactly one kind:
- note_provided — keep the selected service; the text is visit detail (concern, symptom, body area, what they have in mind)
- note_skipped — they decline to leave a note
- service_change_requested — they explicitly ask to book or switch the visit to a different service
- service_or_note_clarification_required — the same sentence could mean keep the selected service as a note, or switch to a different service type named in the text
- schedule_change_requested — they ask to change day or time (no snapshot match yet)
- leave_booking — unambiguous request to leave booking (rare; prefer unresolved)
- unresolved — cannot classify safely

Decision order:
1. Skip/decline → note_skipped.
2. Explicit book/switch of the visit ("запиши на X", "запиши мене на X", "book me for X", "switch to X") when X is not clearly the already-selected service → service_change_requested. query is the short service span, not the whole sentence.
3. The text names a different visit type than the selected service AND could still be a comment about this visit (e.g. selected is a named procedure, they ask for a consultation about that procedure; or selected is consultation, they ask to change the booked service) → service_or_note_clarification_required. Do not pick a CRM id. query is the other service type span.
4. Area, zone, or concern without an explicit switch/book-the-visit command — including "хочу X у зоні Y" / "want X in the Y area" — → note_provided. Naming a treatment as what they have in mind is still a note when they locate it on the body.
5. Otherwise unresolved.

Rules:
- Never invent a CRM service id.
- Optional query is a short span copied from the patient text, not a paraphrase.
- Do not return a note value or rewritten sentence.
- Ukrainian, English, and mixed language are all valid.
- Compare against the current accepted service name when judging mixed vs change vs note.

Contrastive patterns (kinds only; not catalog names):
- Selected «Консультація», "запиши на лазер" → service_change_requested (query: лазер)
- Selected «Пілінг», "I need a consultation regarding the peel" → service_or_note_clarification_required (query: consultation)
- Selected «Консультація», "хочу лазер у зоні щік" → note_provided
- Selected any, "ні" / "skip" → note_skipped`;

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
      { role: "system", content: NOTE_TURN_CLASSIFIER_INSTRUCTION },
      {
        role: "user",
        content: `${serviceLine}\nPatient message:\n${patientText}`,
      },
    ]);
    return result as NoteTurnClassification;
  };
};
