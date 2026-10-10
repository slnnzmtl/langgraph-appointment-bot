import { z } from "zod";

import type { ILLMConnector } from "./types.js";

export const CONTACT_NAME_TURN_KINDS = ["name", "aside"] as const;

export type ContactNameTurnKind = (typeof CONTACT_NAME_TURN_KINDS)[number];

export type ContactNameTurnClassification =
  | { kind: "name"; value: string }
  | { kind: "aside" };

export const contactNameTurnClassificationSchema = z.object({
  kind: z.enum(CONTACT_NAME_TURN_KINDS),
  /** Required when kind is name; ignored for aside. */
  value: z.string().min(1).max(48).optional(),
}).strict();

export type ClassifyContactNameTurn = (input: {
  patientText: string;
  field: "firstName" | "lastName";
}) => Promise<ContactNameTurnClassification>;

export const CONTACT_NAME_TURN_CLASSIFIER_INSTRUCTION = `You classify one patient reply while the clinic booking bot is collecting a contact name.

The open field is either firstName (given name / ім'я) or lastName (surname / прізвище). The bot just asked for that field.

Return exactly one kind:
- name — the message is answering with that name (possibly with light punctuation). Put the cleaned name in value (letters, spaces, hyphen, apostrophe only; strip titles). Uncommon, foreign, or unusual given names still count as name when they are clearly the answer to the open field.
- aside — the message is not answering the name field: a question, greeting, price/FAQ ask, booking/service request, decline, phone number, or multi-sentence chat. Omit value.

Rules:
- When the reply is a short 1–2 token answer to the open field and is not clearly a question/greeting/request, return name — even if the token is uncommon or also an English common noun (e.g. Smoke, Apple, River as a given name).
- Prefer aside only when the message clearly is not a name submission (question mark, greeting phrase, service request, price ask).
- Do not invent a name that is not in the patient message.
- Ukrainian, English, and mixed language are valid.
- Do not use word lists or greeting dictionaries; decide from whether the message answers the open name field.

Examples (open field firstName):
- Patient: Олена → name value Олена
- Patient: Smoke → name value Smoke
- Patient: скільки коштує → aside
- Patient: добрий день → aside
- Patient: хочу ботокс → aside`;

const normalizeClassification = (
  raw: { kind: ContactNameTurnKind; value?: string },
): ContactNameTurnClassification => {
  if (raw.kind === "name") {
    const value = raw.value?.trim() ?? "";
    if (value.length > 0) {
      return { kind: "name", value };
    }
  }
  return { kind: "aside" };
};

export const createContactNameClassifier = (llm: ILLMConnector): ClassifyContactNameTurn => {
  const chain = llm.bindRoutingTools(
    contactNameTurnClassificationSchema,
    { name: "classify_contact_name_turn" },
  );

  return async ({ patientText, field }) => {
    const fieldLine = field === "firstName"
      ? "Open field: firstName (given name / ім'я)."
      : "Open field: lastName (surname / прізвище).";
    const result = await chain.invoke([
      { role: "system", content: CONTACT_NAME_TURN_CLASSIFIER_INSTRUCTION },
      {
        role: "user",
        content: `${fieldLine}\nPatient message:\n${patientText}`,
      },
    ]);
    return normalizeClassification(result as { kind: ContactNameTurnKind; value?: string });
  };
};
