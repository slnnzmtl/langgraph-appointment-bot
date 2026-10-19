import { describe, expect, it, vi } from "vitest";

import {
  BOOKING_OFFER_MENU,
  CONSULTATION_SERVICE_ID,
  SERVICE_CONFIRM_CONSULTATION_UK,
} from "../../../shared/clinic-constants.js";
import { setTrackEventForTests } from "../../../analytics/track.js";
import type { BookingDecision } from "../../booking-domain/decision.js";
import type { ILLMConnector } from "../../types.js";
import { createBookingRespondNode } from "../booking-respond.js";
import { replyChoicesFromCard } from "../booking-card-choices.js";

const confirmServiceDecision = (): BookingDecision => ({
  tag: "ask",
  intent: "confirm_service",
  facts: { serviceId: CONSULTATION_SERVICE_ID },
  card: {
    kind: "service_confirm",
    serviceId: CONSULTATION_SERVICE_ID,
    choiceIds: ["offer_accept", "offer_choose_other"],
    labels: {
      offer_accept: BOOKING_OFFER_MENU[0],
      offer_choose_other: BOOKING_OFFER_MENU[1],
    },
  },
});

const llmReturning = (text: string): ILLMConnector => ({
  bindRoutingTools: () => ({
    invoke: async () => ({ text }),
  }),
} as unknown as ILLMConnector);

describe("booking__respond card copy + markup", () => {
  it("ships code-owned confirm_service copy and replyButtons only (no replyChoices)", async () => {
    const invoke = vi.fn(async () => ({
      text: "Ви обрали послугу. Будь ласка, оберіть зручну дату та час для запису.",
    }));
    const node = createBookingRespondNode({
      llm: {
        bindRoutingTools: () => ({ invoke }),
      } as unknown as ILLMConnector,
    });
    const decision = confirmServiceDecision();
    const update = await node({
      bookingDecision: decision,
      bookingDraft: null,
    } as never);

    expect(invoke).not.toHaveBeenCalled();
    expect(update.lastHandoff?.replyText).toBe(SERVICE_CONFIRM_CONSULTATION_UK);
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(update.lastHandoff?.replyChoices).toBeUndefined();
  });

  it("rejects bare intent success without terminal commit", async () => {
    const events: Array<{ name: string }> = [];
    setTrackEventForTests((name) => {
      events.push({ name });
    });
    try {
      const node = createBookingRespondNode({
        llm: llmReturning("ok"),
      });
      const update = await node({
        bookingDecision: {
          tag: "ask",
          intent: "success",
          facts: {},
          card: null,
        },
      } as never);

      expect(update.lastHandoff?.replyText).not.toMatch(/підтверджено|готово/i);
      expect(events.some((e) => e.name === "false_success_claim")).toBe(true);
    } finally {
      setTrackEventForTests(null);
    }
  });

  it("emits code-owned success only for terminal committed mutation", async () => {
    const node = createBookingRespondNode({
      llm: llmReturning("should not be used"),
    });
    const update = await node({
      bookingDecision: {
        tag: "terminal",
        intent: "success",
        reason: "success",
        facts: {
          serviceName: "Консультація",
          date: "2026-10-21",
          time: "10:00",
        },
        card: null,
      },
    } as never);

    expect(update.lastHandoff?.replyText).toContain("Готово");
    expect(update.lastHandoff?.replyText).toContain("Консультація");
    expect(update.lastHandoff?.replyText).toContain("2026-10-21");
    expect(update.lastHandoff?.replyChoices).toBeUndefined();
  });
});

describe("replyChoicesFromCard offer labels", () => {
  it("defaults offer_accept / offer_choose_other to Так / Обрати іншу процедуру", () => {
    const choices = replyChoicesFromCard({
      kind: "service_confirm",
      serviceId: CONSULTATION_SERVICE_ID,
      choiceIds: ["offer_accept", "offer_choose_other"],
    });
    expect(choices.map((c) => c.label)).toEqual([...BOOKING_OFFER_MENU]);
  });
});
