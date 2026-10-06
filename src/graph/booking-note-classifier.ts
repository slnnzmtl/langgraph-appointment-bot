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
- service_change_requested — they are replacing which service this visit is for; the booked row should change
- service_or_note_clarification_required — the same sentence could mean keep the selected service as a note, or switch to a different service type named in the text
- schedule_change_requested — they ask to change day or time (no snapshot match yet)
- leave_booking — unambiguous request to leave booking (rare; prefer unresolved)
- unresolved — cannot classify safely

Decision order (compare against the current accepted service name):
1. Decline to leave a note → note_skipped.
2. They are replacing which service this visit is for (the booked row should change to a different visit type) → service_change_requested. query is the short service span copied from the patient text, not the whole sentence.
3. They locate a treatment or concern on the body for this already-selected visit → note_provided. This stays a note even when the treatment name differs from the selected service; the body location marks visit detail, not a service switch.
4. The text names a different visit type than the selected service AND can still be a comment about this visit — reason for coming, what they have in mind, consultation about a procedure, or a procedure named while a consultation (or other service) is already selected — and does not locate that treatment on the body → service_or_note_clarification_required. Do not pick a CRM id. Do not resolve catalog. query is the other service type span from the patient text.
5. Other concern or symptom about the already selected visit with no other visit type named → note_provided.
6. Otherwise unresolved.

Rules:
- Never invent a CRM service id.
- Optional query is a short span copied from the patient text, not a paraphrase.
- Do not return a note value or rewritten sentence.
- Ukrainian, English, and mixed language are all valid.
- Decide from selected service vs what the sentence is doing. Do not use command-phrase lists, verb allowlists, stem dictionaries, or catalog/brand names as the decision mechanism.

Contrastive situations (kinds only; no trigger phrases or catalog names):
- Selected service A; patient clearly replaces this visit with a different visit type → service_change_requested
- Selected any; patient locates a treatment or concern on the body for this visit (even if the treatment name differs from the selected service) → note_provided
- Selected a named procedure; patient speaks of a consultation about that procedure → service_or_note_clarification_required
- Selected a consultation; patient names another procedure as a wish or concern without locating it on the body and without replacing the visit → service_or_note_clarification_required
- Selected any; patient declines a note → note_skipped`;

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
