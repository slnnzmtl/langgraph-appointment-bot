import { describe, expect, it } from "vitest";

import {
  frozenCommandsEqual,
  hitlCommandsMatch,
  normalizeCrmCommandPayload,
} from "../hitl-command-match.js";
import type { BookingDraft } from "../booking/booking-draft.js";
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

const matchingDraft = (overrides?: Partial<BookingDraft>): BookingDraft =>
  ({
    pendingDecision: {
      kind: "mutation_confirm" as const,
      action: "create" as const,
      effectId: "eff_create_1",
      frozenCommand: frozen(),
    },
    pendingEffect: {
      id: "eff_create_1",
      status: "prepared" as const,
      effect: {
        kind: "create_meeting" as const,
        payload: { ...createPayload },
      },
    },
    ...overrides,
  }) as BookingDraft;

const matchingInterrupt = {
  type: "confirm_booking",
  draft: {
    command: {
      action: "create",
      payload: { ...createPayload },
    },
  },
};

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
    expect(
      hitlCommandsMatch(matchingDraft(), {
        type: "confirm_booking",
        draft: {
          command: {
            action: "create",
            payload: { ...createPayload, description: "TAMPERED" },
          },
        },
      }),
    ).toBe(false);
  });

  it("hitlCommandsMatch accepts a matching interrupt with correlated effect ids", () => {
    expect(hitlCommandsMatch(matchingDraft(), matchingInterrupt)).toBe(true);
  });

  it("declines when pendingEffect is missing", () => {
    expect(
      hitlCommandsMatch(
        matchingDraft({ pendingEffect: null }),
        matchingInterrupt,
      ),
    ).toBe(false);
  });

  it("declines when frozenCommand is missing (no reconstruct)", () => {
    const draft = matchingDraft();
    const pending = draft.pendingDecision;
    expect(
      hitlCommandsMatch(
        {
          ...draft,
          pendingDecision:
            pending?.kind === "mutation_confirm"
              ? {
                  kind: "mutation_confirm",
                  action: pending.action,
                  effectId: pending.effectId,
                }
              : pending,
          pendingCommand: {
            action: "create",
            payload: { ...createPayload },
          },
        } as BookingDraft,
        matchingInterrupt,
      ),
    ).toBe(false);
  });

  it("declines when frozen cancel id disagrees with current pendingEffect", () => {
    expect(
      hitlCommandsMatch(
        matchingDraft({
          pendingDecision: {
            kind: "mutation_confirm",
            action: "cancel",
            effectId: "eff_old_cancel",
            frozenCommand: frozen({
              action: "cancel",
              effectId: "eff_old_cancel",
              payload: { id: "m-1" },
            }),
          },
          pendingEffect: {
            id: "eff_new_create",
            status: "prepared",
            effect: {
              kind: "create_meeting",
              payload: { ...createPayload },
            },
          },
        }),
        {
          type: "confirm_booking",
          draft: {
            command: {
              action: "create",
              payload: { ...createPayload },
            },
          },
        },
      ),
    ).toBe(false);
  });
});
