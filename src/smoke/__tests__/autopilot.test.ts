import { describe, expect, it } from "vitest";

import {
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  INTENT_SKIP_LABEL,
  LATER_DATE_LABEL,
  OTHER_DATE_LABEL,
} from "../../shared/clinic-constants.js";
import { CONSULTATION_SERVICE_ID } from "../../shared/clinic-constants.js";
import { nextAutopilotInput } from "../autopilot.js";

describe("nextAutopilotInput", () => {
  const base = {
    phone: "+380501112233",
    firstName: "Smoke",
    lastName: "Patient",
    decision: "confirm" as const,
  };

  it("accepts service_confirm with Так", () => {
    expect(
      nextAutopilotInput(
        {
          pendingInteraction: {
            kind: "service_confirm",
            service: {
              id: CONSULTATION_SERVICE_ID,
              name: "Консультація",
              source: "catalog",
            },
            choices: [
              { id: "accept", label: "Так" },
              { id: "choose_other", label: "Обрати іншу процедуру" },
            ],
          },
        },
        base,
      ),
    ).toBe("Так");
  });

  it("picks first real date, skipping Інша дата", () => {
    expect(
      nextAutopilotInput(
        {
          pendingInteraction: {
            kind: "date_select",
            snapshot: {
              snapshotId: "s",
              queryKind: "nearest",
              days: [],
            },
            choices: [
              { id: "other_date", label: OTHER_DATE_LABEL },
              { id: "2026-10-20", label: "20 жовтня" },
            ],
          },
        },
        base,
      ),
    ).toBe("20 жовтня");
  });

  it("pages later when a date list has no bookable day", () => {
    expect(
      nextAutopilotInput(
        {
          pendingInteraction: {
            kind: "date_select",
            snapshot: {
              snapshotId: "s",
              queryKind: "nearest",
              days: [],
            },
            choices: [
              { id: "other_date", label: OTHER_DATE_LABEL },
              { id: "later", label: LATER_DATE_LABEL },
            ],
          },
        },
        base,
      ),
    ).toBe(LATER_DATE_LABEL);
  });

  it("picks first time slot", () => {
    expect(
      nextAutopilotInput(
        {
          pendingInteraction: {
            kind: "time_select",
            date: "2026-10-20",
            snapshot: {
              snapshotId: "s",
              queryKind: "nearest",
              days: [],
            },
            choices: [
              { id: "11:00", label: "11:00" },
              { id: "other_date", label: OTHER_DATE_LABEL },
            ],
          },
        },
        base,
      ),
    ).toBe("11:00");
  });

  it("fills contact fields from options", () => {
    expect(
      nextAutopilotInput(
        {
          pendingInteraction: {
            kind: "contact_field",
            field: "phoneNumber",
            choices: [],
          },
        },
        base,
      ),
    ).toBe(base.phone);
    expect(
      nextAutopilotInput(
        {
          pendingInteraction: {
            kind: "contact_field",
            field: "firstName",
            choices: [],
          },
        },
        base,
      ),
    ).toBe("Smoke");
  });

  it("skips visit note and confirms or declines mutation", () => {
    expect(
      nextAutopilotInput(
        {
          pendingInteraction: {
            kind: "visit_note",
            choices: [{ id: "skip", label: INTENT_SKIP_LABEL }],
          },
        },
        base,
      ),
    ).toBe(INTENT_SKIP_LABEL);

    expect(
      nextAutopilotInput(
        {
          pendingInteraction: {
            kind: "mutation_confirm",
            action: "create",
            choices: [
              { id: "confirm", label: CONFIRM_YES_LABEL },
              { id: "decline", label: CONFIRM_NO_LABEL },
            ],
          },
          pendingConfirm: true,
        },
        base,
      ),
    ).toBe(CONFIRM_YES_LABEL);

    expect(
      nextAutopilotInput(
        {
          pendingInteraction: {
            kind: "mutation_confirm",
            action: "create",
            choices: [
              { id: "confirm", label: CONFIRM_YES_LABEL },
              { id: "decline", label: CONFIRM_NO_LABEL },
            ],
          },
          pendingConfirm: true,
        },
        { ...base, decision: "decline" },
      ),
    ).toBe(CONFIRM_NO_LABEL);

    expect(
      nextAutopilotInput(
        {
          pendingInteraction: {
            kind: "mutation_confirm",
            action: "create",
            choices: [
              { id: "confirm", label: CONFIRM_YES_LABEL },
              { id: "decline", label: CONFIRM_NO_LABEL },
            ],
          },
        },
        base,
      ),
    ).toBeNull();
  });

  it("returns null for visit_select and when idle", () => {
    expect(
      nextAutopilotInput(
        {
          pendingInteraction: {
            kind: "visit_select",
            stage: "action",
            choices: [{ id: "reschedule", label: "Перенести" }],
          },
        },
        base,
      ),
    ).toBeNull();
    expect(nextAutopilotInput({ pendingInteraction: null }, base)).toBeNull();
  });

  it("uses pendingConfirm when interaction is null", () => {
    expect(
      nextAutopilotInput({ pendingInteraction: null, pendingConfirm: true }, base),
    ).toBe(CONFIRM_YES_LABEL);
  });
});
