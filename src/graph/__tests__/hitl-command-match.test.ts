import { describe, expect, it } from "vitest";

import {
  frozenCommandsEqual,
  hitlCommandsMatch,
  normalizeCrmCommandPayload,
} from "../hitl-command-match.js";
import type { BookingDraft } from "../booking-draft.js";
import type { FrozenMutationCommand } from "../booking-domain/session.js";

const createPayload = {
  name: "Консультація - Test User",
  dateStart: "2026-10-24T13:00:00",
  dateEnd: "2026-10-24T13:30:00",
  assignedUserId: "user-1",
  parentType: "Contact",
  parentId: "c-1",
  contactsIds: ["c-1"],
  cServicesIds: ["svc-1"],
  status: "Planned",
  description: "note",
  location: "Kyiv",
};

const frozen = (overrides?: Partial<FrozenMutationCommand>): FrozenMutationCommand => ({
  action: "create",
  effectId: "eff_create_1",
  payload: { ...createPayload },
  ...overrides,
});

describe("HITL full CRM command match", () => {
  it("normalizes local ISO times without seconds", () => {
    expect(normalizeCrmCommandPayload({ dateStart: "2026-10-24T13:00" })).toEqual({
      dateStart: "2026-10-24T13:00:00",
    });
  });

  it("matches identical frozen commands", () => {
    expect(frozenCommandsEqual(frozen(), frozen())).toBe(true);
  });

  it("fails when assignedUserId differs", () => {
    expect(
      frozenCommandsEqual(
        frozen(),
        frozen({
          payload: { ...createPayload, assignedUserId: "user-OTHER" },
        }),
      ),
    ).toBe(false);
  });

  it("fails when effect id is missing", () => {
    expect(
      frozenCommandsEqual(frozen({ effectId: "" }), frozen()),
    ).toBe(false);
  });

  it("hitlCommandsMatch declines when interrupt payload is tampered", () => {
    const draft = {
      pendingDecision: {
        kind: "mutation_confirm" as const,
        action: "create" as const,
        effectId: "eff_create_1",
        frozenCommand: frozen(),
      },
    } as BookingDraft;

    const interrupt = {
      type: "confirm_booking",
      draft: {
        command: {
          action: "create",
          payload: { ...createPayload, description: "TAMPERED" },
        },
      },
    };
    expect(hitlCommandsMatch(draft, interrupt)).toBe(false);
  });

  it("hitlCommandsMatch accepts a matching interrupt", () => {
    const draft = {
      pendingDecision: {
        kind: "mutation_confirm" as const,
        action: "create" as const,
        effectId: "eff_create_1",
        frozenCommand: frozen(),
      },
    } as BookingDraft;

    const interrupt = {
      type: "confirm_booking",
      draft: {
        command: {
          action: "create",
          payload: { ...createPayload },
        },
      },
    };
    expect(hitlCommandsMatch(draft, interrupt)).toBe(true);
  });
});
