import {
  AIMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createBookingFinalizeNode,
  createFaqFinalizeNode,
  createAgentLlmNode,
  createBookingPrepareNode,
  formatAvailabilityDateOffer,
  formatAvailabilityTimeOffer,
  routeAfterAgentTools,
} from "../agent-loop/index.js";
import { setTrackEventForTests } from "../../analytics/track.js";
import { extractMessageTextContent } from "../../shared/message-content.js";
import {
  BOOKING_AWAITING_CONFIRM_UK,
  BOOKING_CONTACT_SAVE_FAILED_UK,
  BOOKING_OFFER_MENU,
  BOOKING_PHONE_OCCUPIED_UK,
  BOOKING_PHONE_QUESTION_UK,
  BOOKING_REPLACE_MENU,
  CLINIC_ADDRESS,
  CONFIRM_NO_LABEL,
  CONFIRM_YES_LABEL,
  CONSULTATION_SERVICE_ID,
  INTENT_SKIP_LABEL,
  OTHER_DATE_LABEL,
  PATIENT_FALLBACK_MESSAGE,
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  BOOKING_SCHEDULE_RESELECT_UK,
  serviceChangedNoticeUk,
} from "../../shared/clinic-constants.js";
import type { AvailabilityContext } from "../../tools/availability-tools.js";
import type { BookingContext } from "../../tools/planned-meetings.js";
import {
  createEmptyBookingDraft,
  reduceBookingDraft,
} from "../booking-draft.js";
import type { BookingDraft } from "../booking-draft.js";
import {
  CONTACT_LINK_CANDIDATE_REQUIRED_ERROR,
  terminalContactWriteOutcome,
} from "../agent-loop/protocol.js";
import { type ClinicAgentDefinition } from "../types.js";

import {
  canonicalBookingDraft,
  clinicState,
  makeListedMeetings,
  ownedContactContext,
  runtimeToolAi,
  unwrapCommandUpdate,
} from "./agent-loop-fixtures.js";

/** Ukrainian modifier letter apostrophe (U+02BC). */
const DARYA_MODIFIER = "Дарʼя";

describe("createBookingFinalizeNode / createFaqFinalizeNode", () => {
  it("replaces model prose with the service-change notice while DATE reselection is open", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const notice = serviceChangedNoticeUk("Збільшення губ Neotiva");
    const update = await finalize(
      clinicState({
        serviceChangeNotice: notice,
        bookingDraft: canonicalBookingDraft({
          phase: "date",
          selectedDate: null,
          selectedSlot: null,
          note: { status: "answered", value: "запиши на збільшення губ" },
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-neotiva",
              name: "Збільшення губ Neotiva",
              durationMinutes: 60,
              source: "catalog",
            },
          },
        }),
        agentMessages: [new AIMessage("You're all booked!")],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(notice);
    expect(update.lastHandoff?.replyText).not.toContain("booked");
    expect(update.serviceChangeNotice).toBeNull();
  });

  it("replaces any-language model prose with the code-owned DATE prompt", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "date",
          selectedDate: null,
          selectedSlot: null,
        }),
        agentMessages: [new AIMessage("Done — your appointment is confirmed.")],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(BOOKING_SCHEDULE_RESELECT_UK);
    expect(update.lastHandoff?.replyButtons ?? []).toEqual([]);
  });

  it("recovers the TIME card from checkpoint when selectedDate is still open", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const days: AvailabilityContext["days"] = [
      {
        date: "2026-10-19",
        dayLabel: "19 жовтня (понеділок)",
        slots: [
          { id: "s1", label: "11:30", dateStart: "2026-10-19T11:30:00", dateEnd: "2026-10-19T12:00:00" },
          { id: "s2", label: "12:30", dateStart: "2026-10-19T12:30:00", dateEnd: "2026-10-19T13:00:00" },
        ],
      },
      {
        date: "2026-10-20",
        dayLabel: "20 жовтня (вівторок)",
        slots: [
          { id: "s3", label: "12:00", dateStart: "2026-10-20T12:00:00", dateEnd: "2026-10-20T12:30:00" },
        ],
      },
      {
        date: "2026-10-22",
        dayLabel: "22 жовтня (четвер)",
        slots: [
          { id: "s4", label: "11:00", dateStart: "2026-10-22T11:00:00", dateEnd: "2026-10-22T11:30:00" },
          { id: "s5", label: "11:30", dateStart: "2026-10-22T11:30:00", dateEnd: "2026-10-22T12:00:00" },
          { id: "s6", label: "12:00", dateStart: "2026-10-22T12:00:00", dateEnd: "2026-10-22T12:30:00" },
          { id: "s7", label: "14:30", dateStart: "2026-10-22T14:30:00", dateEnd: "2026-10-22T15:00:00" },
        ],
      },
    ];
    const update = await finalize(
      clinicState({
        messages: [new HumanMessage("все ж таки запиши на консультацію")],
        bookingDraft: canonicalBookingDraft({
          phase: "time",
          selectedDate: "2026-10-22",
          selectedSlot: null,
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "6a884971a722ecdf2",
              name: "Ботулінотерапія Botox, Disport 2 зони",
              durationMinutes: 30,
              source: "catalog",
            },
          },
        }),
        availabilityContext: {
          serviceId: "6a884971a722ecdf2",
          days,
          stepMinutes: 30,
          query: {
            kind: "nearest",
            anchor: "2026-10-07",
            rangeFrom: "2026-10-07",
            rangeThrough: "2026-10-22",
            coverageComplete: true,
          },
        },
        agentMessages: [new AIMessage("You're all booked!")],
      }),
    );

    const expected = formatAvailabilityTimeOffer(days[2]!);
    expect(update.lastHandoff?.replyText).toBe(expected.replyText);
    expect(update.lastHandoff?.replyButtons).toEqual(expected.replyButtons);
    expect(update.lastHandoff?.replyText).not.toBe(BOOKING_SCHEDULE_RESELECT_UK);
    expect(update.lastHandoff?.replyText).not.toContain("booked");
  });

  it("recovers the DATE card from checkpoint when selectedDate is cleared", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const days: AvailabilityContext["days"] = [
      {
        date: "2026-10-20",
        dayLabel: "20 жовтня (вівторок)",
        slots: [
          { id: "s1", label: "12:00", dateStart: "2026-10-20T12:00:00", dateEnd: "2026-10-20T12:30:00" },
        ],
      },
      {
        date: "2026-10-22",
        dayLabel: "22 жовтня (четвер)",
        slots: [
          { id: "s2", label: "11:00", dateStart: "2026-10-22T11:00:00", dateEnd: "2026-10-22T11:30:00" },
        ],
      },
    ];
    const availability: AvailabilityContext = {
      serviceId: "svc-1",
      days,
      stepMinutes: 30,
      query: {
        kind: "nearest",
        rangeFrom: "2026-10-08",
        rangeThrough: "2026-10-22",
        coverageComplete: true,
      },
    };
    const update = await finalize(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "date",
          selectedDate: null,
          selectedSlot: null,
        }),
        availabilityContext: availability,
        agentMessages: [new AIMessage("Done — your appointment is confirmed.")],
      }),
    );

    const expected = formatAvailabilityDateOffer(availability);
    expect(update.lastHandoff?.replyText).toBe(expected.replyText);
    expect(update.lastHandoff?.replyButtons).toEqual(expected.replyButtons);
  });

  it("does not reuse a checkpoint snapshot for a different accepted service", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "date",
          selectedDate: null,
          selectedSlot: null,
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-consult",
              name: "Консультація",
              durationMinutes: 30,
              source: "catalog",
            },
          },
        }),
        availabilityContext: {
          serviceId: "svc-botox",
          days: [
            {
              date: "2026-10-22",
              dayLabel: "22 жовтня (четвер)",
              slots: [
                {
                  id: "s1",
                  label: "11:00",
                  dateStart: "2026-10-22T11:00:00",
                  dateEnd: "2026-10-22T11:30:00",
                },
              ],
            },
          ],
          stepMinutes: 30,
        },
        agentMessages: [new AIMessage("You're all booked!")],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(BOOKING_SCHEDULE_RESELECT_UK);
    expect(update.lastHandoff?.replyButtons ?? []).toEqual([]);
  });

  it("prefixes a recovered TIME card with the service-change notice", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const notice = serviceChangedNoticeUk("Консультація");
    const day: AvailabilityContext["days"][number] = {
      date: "2026-10-22",
      dayLabel: "22 жовтня (четвер)",
      slots: [
        { id: "s1", label: "11:00", dateStart: "2026-10-22T11:00:00", dateEnd: "2026-10-22T11:30:00" },
        { id: "s2", label: "12:00", dateStart: "2026-10-22T12:00:00", dateEnd: "2026-10-22T12:30:00" },
      ],
    };
    const update = await finalize(
      clinicState({
        serviceChangeNotice: notice,
        bookingDraft: canonicalBookingDraft({
          phase: "time",
          selectedDate: "2026-10-22",
          selectedSlot: null,
        }),
        availabilityContext: {
          serviceId: "svc-1",
          days: [day],
          stepMinutes: 30,
        },
        agentMessages: [new AIMessage("Готово!")],
      }),
    );

    const expected = formatAvailabilityTimeOffer(day);
    expect(update.lastHandoff?.replyText).toBe(`${notice}\n\n${expected.replyText}`);
    expect(update.lastHandoff?.replyButtons).toEqual(expected.replyButtons);
    expect(update.serviceChangeNotice).toBeNull();
  });

  it("prefixes the DATE card with the service-change notice and then clears it", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const notice = serviceChangedNoticeUk("Збільшення губ Neotiva");
    const days: AvailabilityContext["days"] = [
      {
        date: "2026-10-20",
        dayLabel: "20 жовтня (вівторок)",
        slots: [
          {
            id: "s1",
            label: "12:00",
            dateStart: "2026-10-20T12:00:00",
            dateEnd: "2026-10-20T13:00:00",
          },
        ],
      },
      {
        date: "2026-10-22",
        dayLabel: "22 жовтня (четвер)",
        slots: [
          {
            id: "s2",
            label: "11:00",
            dateStart: "2026-10-22T11:00:00",
            dateEnd: "2026-10-22T12:00:00",
          },
        ],
      },
    ];
    const update = await finalize(
      clinicState({
        serviceChangeNotice: notice,
        bookingDraft: canonicalBookingDraft({
          phase: "date",
          selectedDate: null,
          selectedSlot: null,
          note: { status: "answered", value: "запиши на збільшення губ" },
          serviceAcceptance: {
            status: "accepted",
            service: {
              id: "svc-neotiva",
              name: "Збільшення губ Neotiva",
              durationMinutes: 60,
              source: "catalog",
            },
          },
        }),
        agentMessages: [
          runtimeToolAi([{
              id: "slots-1",
              name: "present_availability_slots",
              args: { direction: "nearest", durationMinutes: 60 },
              type: "tool_call",
            }]),
          new ToolMessage({
            content: JSON.stringify({
              days,
              stepMinutes: 60,
              query: {
                kind: "nearest",
                rangeFrom: "2026-10-08",
                rangeThrough: "2026-10-22",
                coverageComplete: true,
              },
            }),
            tool_call_id: "slots-1",
            name: "present_availability_slots",
          }),
          new AIMessage("Готово! Запис створено."),
        ],
      }),
    );

    const reply = String(update.lastHandoff?.replyText ?? "");
    expect(reply.startsWith(notice)).toBe(true);
    expect(reply).toContain("20 жовтня");
    expect(reply).toContain("22 жовтня");
    expect(reply).not.toContain("Запис створено");
    expect(update.serviceChangeNotice).toBeNull();
    expect(update.lastHandoff?.replyButtons).toEqual(
      expect.arrayContaining(["20 жовтня", "22 жовтня"]),
    );
  });

  it.each([
    "Готово! Запис створено.",
    "Готово! Запис перенесено.",
    "Запис скасовано.",
    "Вас записано на консультацію.",
    "Ви записані на процедуру.",
    "Бронювання підтверджено.",
  ])("code-owns the unresolved-contact question regardless of model prose: %s", async (claim) => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
        }),
        agentMessages: [new HumanMessage("Продовжити без коментаря"), new AIMessage(claim)],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(BOOKING_PHONE_QUESTION_UK);
    expect(extractMessageTextContent((update.messages as AIMessage[])[0]!.content)).toBe(
      BOOKING_PHONE_QUESTION_UK,
    );
  });

  it("leftover mutation_confirm cannot attach ✅/❌ on the phone details step", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
        }),
        pendingInteraction: {
          kind: "mutation_confirm",
          action: "create",
          choices: [
            { id: "confirm", label: CONFIRM_YES_LABEL },
            { id: "decline", label: CONFIRM_NO_LABEL },
          ],
        },
        agentMessages: [
          new HumanMessage("Продовжити без коментаря"),
          new AIMessage("Готово! Запис створено."),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(BOOKING_PHONE_QUESTION_UK);
    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "phoneNumber",
    });
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("routes create_contact operational failure to finalize with patient-safe copy", async () => {
    const draft = canonicalBookingDraft({
      phase: "details",
      contactId: null,
      contactDetails: {
        phoneNumber: "+380501112233",
        firstName: "Дар'я",
        lastName: "Тест",
      },
    });
    const state = clinicState({
      bookingDraft: draft,
      pendingInteraction: null,
      agentMessages: [
        runtimeToolAi([{
            id: "cc-fail",
            name: "create_contact",
            args: {
              phoneNumber: "+380501112233",
              firstName: "Дар'я",
              lastName: "Тест",
            },
            type: "tool_call",
          }]),
        new ToolMessage({
          content: JSON.stringify({ error: "cTelegram uniqueness conflict" }),
          tool_call_id: "cc-fail",
          name: "create_contact",
        }),
      ],
    });
    expect(
      routeAfterAgentTools(
        state as never,
        "booking__llm",
        "booking__tools",
        "booking__mutation_finalize",
        "booking__command_prepare",
        "booking__note_orchestrator",
        "booking__finalize",
      ),
    ).toBe("booking__finalize");

    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(state);
    expect(update.lastHandoff?.replyText).toBe(BOOKING_CONTACT_SAVE_FAILED_UK);
    expect(unwrapCommandUpdate(update).pendingInteraction).toBeNull();
    expect(unwrapCommandUpdate(update).bookingDraft ?? draft).toMatchObject({
      contactDetails: {
        phoneNumber: "+380501112233",
        firstName: "Дар'я",
        lastName: "Тест",
      },
      selectedSlot: draft.selectedSlot,
    });
    expect(update.lastHandoff?.replyText).not.toContain("cTelegram");
  });

  it("routes link_telegram_to_contact failure to finalize as operational", async () => {
    const state = clinicState({
      bookingDraft: canonicalBookingDraft({
        phase: "details",
        contactId: null,
        contactDetails: {
          phoneNumber: "+380501112233",
          firstName: "Олена",
          lastName: "Коваль",
        },
      }),
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({ error: "MCP shut down" }),
          tool_call_id: "link-1",
          name: "link_telegram_to_contact",
        }),
      ],
    });
    expect(
      routeAfterAgentTools(
        state as never,
        "booking__llm",
        "booking__tools",
        undefined,
        undefined,
        undefined,
        "booking__finalize",
      ),
    ).toBe("booking__finalize");
    const update = await createBookingFinalizeNode(agent)(state);
    expect(update.lastHandoff?.replyText).toBe(BOOKING_CONTACT_SAVE_FAILED_UK);
  });

  it("treats malformed contact-write success without id as operational", async () => {
    const state = clinicState({
      bookingDraft: canonicalBookingDraft({
        phase: "details",
        contactId: null,
        contactDetails: {
          phoneNumber: "+380501112233",
          firstName: "Олена",
          lastName: "Коваль",
        },
      }),
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({ success: true }),
          tool_call_id: "cc-bad",
          name: "create_contact",
        }),
      ],
    });
    expect(
      routeAfterAgentTools(
        state as never,
        "booking__llm",
        "booking__tools",
        undefined,
        undefined,
        undefined,
        "booking__finalize",
      ),
    ).toBe("booking__finalize");
    const update = await createBookingFinalizeNode(agent)(state);
    expect(update.lastHandoff?.replyText).toBe(BOOKING_CONTACT_SAVE_FAILED_UK);
    expect(update.contactContext).toBeUndefined();
  });

  it("asks only lastName for an owned contact missing lastName", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        contactContext: {
          ownership: "telegram",
          contacts: [{
            id: "c-owned",
            phoneNumber: "+380501112233",
            firstName: "Олена",
            lastName: "",
          }],
        },
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: "c-owned",
        }),
        agentMessages: [
          new HumanMessage("Продовжити без коментаря"),
          new AIMessage("Готово!"),
        ],
      }),
    );
    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "lastName",
    });
    expect(update.lastHandoff?.replyText).toBe("Підкажіть, будь ласка, ваше прізвище.");
  });

  it("known_field Name not provided reopens only lastName when still missing", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
          contactDetails: {
            phoneNumber: "+380501112233",
            firstName: "Олена",
          },
        }),
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              error: "Name not provided",
              field: "lastName",
            }),
            tool_call_id: "cc-name",
            name: "create_contact",
          }),
        ],
      }),
    );
    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "lastName",
    });
    expect(update.lastHandoff?.replyText).toBe("Підкажіть, будь ласка, ваше прізвище.");
  });

  it("never reopens an already accepted field after known_field naming it", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
          contactDetails: {
            phoneNumber: "+380501112233",
            firstName: "Олена",
            lastName: "Коваль",
          },
        }),
        pendingInteraction: {
          kind: "contact_field",
          field: "lastName",
          choices: [],
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              error: "Name not provided",
              field: "firstName",
            }),
            tool_call_id: "cc-stale",
            name: "create_contact",
          }),
        ],
      }),
    );
    expect(unwrapCommandUpdate(update).pendingInteraction).toBeNull();
    expect(update.lastHandoff?.replyText).toBe(BOOKING_CONTACT_SAVE_FAILED_UK);
  });

  it("Contact link candidate required reopens occupied phone, not firstName", async () => {
    const state = clinicState({
      contactContext: {
        ownership: "phone",
        contacts: [{
          id: "c-phone",
          phoneNumber: "+380501112233",
          cTelegram: "tg-other",
        }],
      },
      bookingDraft: canonicalBookingDraft({
        phase: "details",
        contactId: null,
        contactDetails: {
          phoneNumber: "+380501112233",
        },
      }),
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({
            error: CONTACT_LINK_CANDIDATE_REQUIRED_ERROR,
            field: "phoneNumber",
          }),
          tool_call_id: "cc-link",
          name: "create_contact",
        }),
      ],
    });
    expect(
      routeAfterAgentTools(
        state as never,
        "booking__llm",
        "booking__tools",
        undefined,
        undefined,
        undefined,
        "booking__finalize",
      ),
    ).toBe("booking__finalize");
    const update = await createBookingFinalizeNode(agent)(state);
    expect(update.lastHandoff?.replyText).toBe(BOOKING_PHONE_OCCUPIED_UK);
    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "phoneNumber",
      occupied: true,
    });
    expect(update.contactContext).toBeNull();
  });

  it("Contact link candidate required retries linking when the candidate is free", async () => {
    const update = await createBookingFinalizeNode(agent)(
      clinicState({
        contactContext: {
          ownership: "phone",
          contacts: [{
            id: "c-phone",
            phoneNumber: "+380501112233",
            cTelegram: null,
          }],
        },
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
          contactDetails: {
            phoneNumber: "+380501112233",
          },
        }),
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              error: CONTACT_LINK_CANDIDATE_REQUIRED_ERROR,
              field: "phoneNumber",
            }),
            tool_call_id: "cc-link",
            name: "create_contact",
          }),
        ],
      }),
    );
    expect(update.lastHandoff?.replyText).toBe(PATIENT_FALLBACK_MESSAGE);
    expect(update.contactContext).toBeUndefined();
  });

  it("a later successful contact write supersedes an earlier failure", () => {
    const state = clinicState({
      bookingDraft: canonicalBookingDraft({
        phase: "details",
        contactId: null,
        contactDetails: {
          phoneNumber: "+380501112233",
          firstName: "Олена",
          lastName: "Коваль",
        },
      }),
      agentMessages: [
        new ToolMessage({
          content: JSON.stringify({
            error: "Name not provided",
            field: "lastName",
          }),
          tool_call_id: "w1",
          name: "create_contact",
        }),
        new ToolMessage({
          content: JSON.stringify({ id: "c-ok" }),
          tool_call_id: "w2",
          name: "create_contact",
        }),
      ],
    });
    expect(terminalContactWriteOutcome(state)).toBeNull();
    expect(
      routeAfterAgentTools(
        state as never,
        "booking__llm",
        "booking__tools",
        undefined,
        undefined,
        undefined,
        "booking__finalize",
      ),
    ).toBe("booking__llm");
  });

  it("code-owns the occupied-phone reply and clears the phone candidate", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        contactContext: {
          ownership: "phone",
          contacts: [{
            id: "c-phone",
            phoneNumber: "+380632123123",
            cTelegram: "tg-other",
          }],
        },
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
        }),
        agentMessages: [
          new HumanMessage("+380 63 212 3123"),
          new AIMessage("Готово! Запис створено."),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(BOOKING_PHONE_OCCUPIED_UK);
    expect(extractMessageTextContent((update.messages as AIMessage[])[0]!.content)).toBe(
      BOOKING_PHONE_OCCUPIED_UK,
    );
    expect(update.contactContext).toBeNull();
  });

  it("keeps the linkable phone-candidate fallback until link succeeds", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        contactContext: {
          ownership: "phone",
          contacts: [{
            id: "c-phone",
            phoneNumber: "+380632123123",
            cTelegram: null,
          }],
        },
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
        }),
        agentMessages: [
          new HumanMessage("+380 63 212 3123"),
          new AIMessage("Готово! Запис створено."),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe(PATIENT_FALLBACK_MESSAGE);
    expect(update.contactContext).toBeUndefined();
  });

  it("advances unresolved contact_field from phone to firstName after a valid phone", async () => {
    const prepare = createBookingPrepareNode();
    const prepared = await prepare(
      clinicState({
        messages: [new HumanMessage("+380501112233")],
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
        }),
        pendingInteraction: {
          kind: "contact_field",
          field: "phoneNumber",
          choices: [],
        },
      }),
    );
    expect(unwrapCommandUpdate(prepared).bookingDraft).toMatchObject({
      contactDetails: { phoneNumber: "+380501112233" },
    });
    expect(unwrapCommandUpdate(prepared).pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "firstName",
    });

    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        messages: [new HumanMessage("+380501112233")],
        bookingDraft: unwrapCommandUpdate(prepared).bookingDraft as BookingDraft,
        pendingInteraction: unwrapCommandUpdate(prepared).pendingInteraction,
        agentMessages: [
          new HumanMessage("+380501112233"),
          new AIMessage("Дякую, записала номер."),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "firstName",
    });
    expect(update.lastHandoff?.replyText).toBe("Підкажіть, будь ласка, ваше ім’я.");
  });

  it("stays on firstName when collected has no firstName (aside)", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        messages: [new HumanMessage("скільки коштує")],
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
          contactDetails: { phoneNumber: "+380501112233" },
        }),
        pendingInteraction: {
          kind: "contact_field",
          field: "firstName",
          choices: [],
        },
        agentMessages: [
          new HumanMessage("скільки коштує"),
          new AIMessage("Спочатку ім’я, будь ласка."),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "firstName",
    });
  });

  it("stays on lastName when collected has no lastName (aside)", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        messages: [new HumanMessage("добрий день")],
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
          contactDetails: { phoneNumber: "+380501112233", firstName: "Олена" },
        }),
        pendingInteraction: {
          kind: "contact_field",
          field: "lastName",
          collected: { firstName: "Олена" },
          choices: [],
        },
        agentMessages: [
          new HumanMessage("добрий день"),
          new AIMessage("Для запису в клініку."),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "lastName",
    });
  });

  it("advances unresolved contact_field from firstName to lastName after collected firstName", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        messages: [new HumanMessage("Smoke")],
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
          contactDetails: { phoneNumber: "+380501112233" },
        }),
        pendingInteraction: {
          kind: "contact_field",
          field: "firstName",
          collected: { firstName: "Smoke" },
          choices: [],
        },
        agentMessages: [
          new HumanMessage("Smoke"),
          new AIMessage("Дякую."),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "lastName",
    });
    expect(update.lastHandoff?.replyText).toBe("Підкажіть, будь ласка, ваше прізвище.");
  });

  it("clears contact_field after collected lastName so create_contact can run", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        messages: [new HumanMessage("Tester")],
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
          contactDetails: {
            phoneNumber: "+380501112233",
            firstName: "Smoke",
            lastName: "Tester",
          },
        }),
        pendingInteraction: {
          kind: "contact_field",
          field: "lastName",
          collected: { firstName: "Smoke", lastName: "Tester" },
          choices: [],
        },
        agentMessages: [
          new HumanMessage("Tester"),
          new AIMessage("Дякую, створю контакт."),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction).toBeNull();
  });

  it("prepare lastName on owned CRM with phone and firstName clears contact_field", async () => {
    const prepare = createBookingPrepareNode( {
      classifyContactName: async () => ({ kind: "name", value: "Коваль" }),
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Коваль")],
        contactContext: {
          ownership: "telegram",
          contacts: [{
            id: "c-owned",
            phoneNumber: "+380501112233",
            firstName: "Олена",
            lastName: "",
          }],
        },
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: "c-owned",
        }),
        pendingInteraction: {
          kind: "contact_field",
          field: "lastName",
          choices: [],
        },
      }),
    );
    expect(unwrapCommandUpdate(update).bookingDraft).toMatchObject({
      contactId: "c-owned",
      contactDetails: { lastName: "Коваль" },
    });
    expect(unwrapCommandUpdate(update).pendingInteraction).toBeNull();
  });

  it("prepare stores a classified firstName and advances to lastName", async () => {
    const prepare = createBookingPrepareNode( {
      classifyContactName: async () => ({ kind: "name", value: "Олена" }),
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Олена")],
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
          contactDetails: { phoneNumber: "+380501112233" },
        }),
        pendingInteraction: {
          kind: "contact_field",
          field: "firstName",
          choices: [],
        },
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft).toMatchObject({
      contactDetails: {
        phoneNumber: "+380501112233",
        firstName: "Олена",
      },
    });
    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "lastName",
    });
  });

  it("prepare leaves firstName open when the classifier returns aside", async () => {
    const prepare = createBookingPrepareNode( {
      classifyContactName: async () => ({ kind: "aside" }),
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("скільки коштує")],
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
        }),
        pendingInteraction: {
          kind: "contact_field",
          field: "firstName",
          choices: [],
        },
      }),
    );

    // Aside does not patch pendingInteraction — the open firstName field stays.
    expect(unwrapCommandUpdate(update).pendingInteraction).toBeUndefined();
  });

  it("prepare stores classified lastName on contactDetails and clears the field", async () => {
    const prepare = createBookingPrepareNode( {
      classifyContactName: async () => ({ kind: "name", value: "Коваль" }),
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage("Коваль")],
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
          contactDetails: { phoneNumber: "+380501112233", firstName: "Олена" },
        }),
        pendingInteraction: {
          kind: "contact_field",
          field: "lastName",
          collected: { firstName: "Олена" },
          choices: [],
        },
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft).toMatchObject({
      contactDetails: {
        phoneNumber: "+380501112233",
        firstName: "Олена",
        lastName: "Коваль",
      },
    });
    expect(unwrapCommandUpdate(update).pendingInteraction).toBeNull();
  });

  it("prepare preserves Дарʼя apostrophe glyph exactly on contactDetails (DDD-206)", async () => {
    const prepare = createBookingPrepareNode( {
      classifyContactName: async () => ({ kind: "name", value: DARYA_MODIFIER }),
    });
    const update = await prepare(
      clinicState({
        messages: [new HumanMessage(DARYA_MODIFIER)],
        bookingDraft: canonicalBookingDraft({
          phase: "details",
          contactId: null,
          contactDetails: { phoneNumber: "+380501112233" },
        }),
        pendingInteraction: {
          kind: "contact_field",
          field: "firstName",
          choices: [],
        },
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction).toMatchObject({
      kind: "contact_field",
      field: "lastName",
    });
    expect(
      (unwrapCommandUpdate(update).bookingDraft as BookingDraft).contactDetails?.firstName,
    ).toBe(DARYA_MODIFIER);
  });

  it("clears create mutation_confirm and invalidates the slot after awaitingConfirmation chat-other", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        contactContext: ownedContactContext(),
        bookingDraft: canonicalBookingDraft({
          phase: "confirming",
          pendingCommand: {
            action: "create",
            payload: {
              contactId: "contact-1",
              serviceId: "svc-1",
              dateStart: "2026-09-10T14:00:00",
              dateEnd: "2026-09-10T14:30:00",
            },
          },
        }),
        pendingInteraction: {
          kind: "mutation_confirm",
          action: "create",
          choices: [
            { id: "confirm", label: "✅" },
            { id: "decline", label: "❌" },
          ],
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              awaitingConfirmation: true,
              userReply: "зачекайте секунду",
            }),
            name: "create_meeting",
            tool_call_id: "create-aside-1",
          }),
          new AIMessage("Добре, зачекаю."),
        ],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction).toBeNull();
    expect(unwrapCommandUpdate(update).bookingDraft?.selectedSlot).toBeNull();
    expect(unwrapCommandUpdate(update).bookingDraft?.pendingCommand).toBeNull();
  });

  it("keeps ✅/❌ after cancel chat-other instead of a stale visit menu", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        bookingContext: makeListedMeetings(),
        bookingDraft: {
          ...createEmptyBookingDraft("create"),
          phase: "confirming",
          pendingCommand: null,
        },
        pendingInteraction: {
          kind: "visit_select",
          stage: "action",
          meetings: [{ id: "m-1", name: "Консультація", dateStart: "2026-08-17T11:00:00" }],
          choices: [
            { id: "reschedule", label: "Перенести" },
            { id: "cancel", label: "Скасувати" },
            { id: "decline", label: "Ні, дякую" },
          ],
        },
        agentMessages: [
          new ToolMessage({
            content: JSON.stringify({
              awaitingConfirmation: true,
              userReply: "Скільки коштує консультація?",
            }),
            name: "cancel_meeting",
            tool_call_id: "cancel-aside-1",
          }),
          new AIMessage("Вартість первинної консультації становить 300 грн."),
        ],
      }),
    );

    // Outcome-risk fail-closed: pending confirmation never ships model prose.
    expect(update.lastHandoff?.replyButtons).toEqual(["✅", "❌"]);
    expect(update.lastHandoff?.replyText).toBe(BOOKING_AWAITING_CONFIRM_UK);
    expect(update.lastHandoff?.replyText).not.toContain("300");
  });

  const agent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books visits",
    systemPrompt: "book",
    maxSteps: 8,
  };

  it("strips reply_buttons from checkpointed history and code-owns consultation shortcuts", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Записатись")],
        agentMessages: [
          new AIMessage(
            "Підібрати вільний час на консультацію?\n\n<reply_buttons>\nТак\nОбрати іншу процедуру\n</reply_buttons>",
          ),
        ],
      }),
    );

    const stored = update.messages?.[0] as AIMessage;
    expect(String(stored.content)).not.toContain("reply_buttons");
    expect(update.lastHandoff).toMatchObject({
      agentId: "booking",
      status: "ok",
      replyButtons: [...BOOKING_OFFER_MENU],
    });
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
    expect(update.lastHandoff?.yieldToSupervisor).toBeUndefined();
  });

  it("persists the consultation as a pending service when the offer is shown", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        messages: [new HumanMessage("Записатись")],
        agentMessages: [new AIMessage("Підібрати вільний час на консультацію?")],
      }),
    );

    expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance).toMatchObject({
      status: "pending",
      service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
    });
  });

  it("does not send leaked Gemini tool XML as the patient reply", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        agentMessages: [
          new AIMessage(
            "<call:default_api:present_availability_slots{afterDate: 2026-09-29,durationMinutes:30}></call:default_api:present_availability_slots>",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText ?? "").not.toContain("call:default_api");
    expect(String((update.messages?.[0] as AIMessage | undefined)?.content ?? "")).not.toContain(
      "call:default_api",
    );
  });

  it("DDD-53: attaches BOOKING OFFER when the consultation question has no trailer", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Записатись")],
        agentMessages: [new AIMessage("Підібрати вільний час на консультацію?")],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
    expect(update.lastHandoff?.yieldToSupervisor).toBeUndefined();
  });

  it("replaces a wrong consultation trailer with BOOKING OFFER", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Записатись")],
        agentMessages: [
          new AIMessage(
            "Записати вас на консультацію?\n<reply_buttons>\nЗаписатись\nПослуги\n</reply_buttons>",
          ),
        ],
      }),
    );

    expect(String(update.messages?.[0]?.content)).not.toContain("reply_buttons");
    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_OFFER_MENU]);
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
  });

  it("strips an empty reply_buttons trailer and omits DEFAULT MENU for mid-flow booking", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        agentMessages: [
          new AIMessage(
            "Could you please provide your phone number?\n<reply_buttons>\n</reply_buttons>",
          ),
        ],
      }),
    );

    const stored = update.messages?.[0] as AIMessage;
    expect(String(stored.content)).toBe("Could you please provide your phone number?");
    expect(String(stored.content)).not.toContain("reply_buttons");
    expect(update.lastHandoff?.replyText).toBe("Could you please provide your phone number?");
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("attaches REPLACE when create_meeting returned Already booked and no trailer", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 2,
        agentMessages: [
          runtimeToolAi([{ id: "1", name: "create_meeting", args: {} }]),
          new ToolMessage({
            content: JSON.stringify({
              error: "Already booked",
              meetings: [{ id: "m-1", name: "Консультація - Ada", dateStart: "2026-09-04 11:00:00" }],
            }),
            tool_call_id: "1",
            name: "create_meeting",
          }),
          new AIMessage("Готово! Запис створено."),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toContain("запланований візит");
    expect(update.lastHandoff?.replyText).not.toContain("Готово");
    expect(update.lastHandoff?.replyButtons).toEqual(["Скасувати", "Ні, дякую"]);
    expect(update.lastHandoff?.status).toBe("ok");
  });

  it("attaches DEFAULT has-visits after a committed create_meeting", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 2,
        agentMessages: [
          runtimeToolAi([{ id: "1", name: "create_meeting", args: {} }]),
          new ToolMessage({
            content: JSON.stringify({
              id: "m-new",
              success: true,
              visitLabel: "Консультація — 10 вересня (четвер) о 14:00",
            }),
            tool_call_id: "1",
            name: "create_meeting",
          }),
          new AIMessage(
            `Готово! Чекаємо вас на консультацію 10 вересня (четвер) о 14:00 ✨\n\n${CLINIC_ADDRESS}`,
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toMatch(/^Готово! Запис створено\./);
    expect(update.lastHandoff?.replyText).toContain("Консультація");
    expect(update.lastHandoff?.replyText).toContain("10 вересня (четвер) о 14:00");
    expect(update.lastHandoff?.replyText).toContain(CLINIC_ADDRESS);
    expect(update.lastHandoff?.replyText).toContain("Мій запис");
    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
  });

  it("attaches DEFAULT no-visits after cancelling the only planned meeting", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 2,
        bookingContext: makeListedMeetings(),
        agentMessages: [
          runtimeToolAi([{ id: "1", name: "cancel_meeting", args: { meetingId: "m-1" } }]),
          new ToolMessage({
            content: JSON.stringify({
              success: true,
              id: "m-1",
            }),
            tool_call_id: "1",
            name: "cancel_meeting",
          }),
          new AIMessage(
            "Візит успішно скасовано. Чи бажаєте підібрати новий час для запису?",
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toContain("скасовано");
    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
  });

  it("keeps DEFAULT has-visits after cancelling one of several meetings", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const twoMeetings: BookingContext = {
      meetings: [
        ...makeListedMeetings().meetings,
        {
          id: "m-2",
          name: "Консультація - Ada",
          dateStart: "2026-08-20 10:00:00",
          dateEnd: "2026-08-20 10:30:00",
        },
      ],
      dateFrom: makeListedMeetings().dateFrom,
    };
    const update = await finalize(
      clinicState({
        stepCount: 2,
        bookingContext: twoMeetings,
        agentMessages: [
          runtimeToolAi([{ id: "1", name: "cancel_meeting", args: { meetingId: "m-1" } }]),
          new ToolMessage({
            content: JSON.stringify({
              success: true,
              id: "m-1",
            }),
            tool_call_id: "1",
            name: "cancel_meeting",
          }),
          new AIMessage("Візит успішно скасовано."),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
  });

  it("DDD-54: attaches DEFAULT MENU after HITL decline on create_meeting", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 2,
        agentMessages: [
          runtimeToolAi([{ id: "1", name: "create_meeting", args: {} }]),
          new ToolMessage({
            content: JSON.stringify({ cancelled: true }),
            tool_call_id: "1",
            name: "create_meeting",
          }),
          new AIMessage("Нічого не записано. Можемо підібрати інший час, коли будете готові."),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_NO_VISITS]);
  });

  it("DDD-54: attaches DEFAULT has-visits after a committed reschedule_meeting", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 2,
        bookingContext: makeListedMeetings(),
        agentMessages: [
          runtimeToolAi([{ id: "1", name: "reschedule_meeting", args: { meetingId: "m-1" } }]),
          new ToolMessage({
            content: JSON.stringify({
              id: "m-1",
              name: "Консультація - Ada",
              dateStart: "2026-09-10 14:00:00",
              dateEnd: "2026-09-10 15:00:00",
            }),
            tool_call_id: "1",
            name: "reschedule_meeting",
          }),
          new AIMessage(
            `Готово! Чекаємо вас на консультацію 10 вересня (четвер) о 14:00 ✨\n\n${CLINIC_ADDRESS}`,
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
  });

  it("DDD-54: emits reply_menu_filled when attaching DEFAULT MENU on idle", async () => {
    const seen: { name: string; props: Record<string, unknown> }[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    try {
      const finalize = createBookingFinalizeNode(agent);
      await finalize(
        clinicState({
          stepCount: 2,
          agentMessages: [
            runtimeToolAi([{ id: "1", name: "create_meeting", args: {} }]),
            new ToolMessage({
              content: JSON.stringify({
                id: "m-new",
                name: "Консультація - Ada",
                dateStart: "2026-09-10 14:00:00",
              }),
              tool_call_id: "1",
              name: "create_meeting",
            }),
            new AIMessage(`Готово!\n\n${CLINIC_ADDRESS}`),
          ],
        }),
      );

      expect(seen).toContainEqual({
        name: "reply_menu_filled",
        props: { menu: "default", reason: "idle" },
      });
    } finally {
      setTrackEventForTests(null);
    }
  });

  it("keeps REPLACE when Already booked and present_availability_slots ran same turn", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const days = [
      {
        date: "2026-09-10",
        dayLabel: "10 вересня (четвер)",
        slots: [
          {
            id: "a",
            label: "14:00",
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T15:00:00",
          },
        ],
      },
    ];
    const update = await finalize(
      clinicState({
        stepCount: 3,
        availabilityContext: { days, stepMinutes: 60 },
        agentMessages: [
          runtimeToolAi([
              { id: "slots", name: "present_availability_slots", args: {} },
              { id: "create", name: "create_meeting", args: {} },
            ]),
          new ToolMessage({
            content: JSON.stringify({ days, stepMinutes: 60 }),
            tool_call_id: "slots",
            name: "present_availability_slots",
          }),
          new ToolMessage({
            content: JSON.stringify({
              error: "Already booked",
              meetings: [{ id: "m-1", name: "Консультація - Ada", dateStart: "2026-09-04 11:00:00" }],
            }),
            tool_call_id: "create",
            name: "create_meeting",
          }),
          new AIMessage("Готово! Запис створено."),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toEqual(["Скасувати", "Ні, дякую"]);
    expect(update.lastHandoff?.replyText).toContain("запланований візит");
    expect(update.lastHandoff?.replyText).not.toContain("Готово");
    expect(update.lastHandoff?.replyText).not.toContain("Найближчі вільні дні");
  });

  it("keeps Готово + DEFAULT when committed create and present_availability_slots ran same turn", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const days = [
      {
        date: "2026-09-29",
        dayLabel: "29 вересня (вівторок)",
        slots: [
          {
            id: "a",
            label: "12:00",
            dateStart: "2026-09-29T12:00:00",
            dateEnd: "2026-09-29T13:00:00",
          },
        ],
      },
    ];
    const update = await finalize(
      clinicState({
        stepCount: 3,
        availabilityContext: { days, stepMinutes: 60 },
        agentMessages: [
          runtimeToolAi([
              { id: "slots", name: "present_availability_slots", args: {} },
              { id: "create", name: "create_meeting", args: {} },
            ]),
          new ToolMessage({
            content: JSON.stringify({ days, stepMinutes: 60 }),
            tool_call_id: "slots",
            name: "present_availability_slots",
          }),
          new ToolMessage({
            content: JSON.stringify({
              success: true,
              id: "m-new",
              visitLabel: "Збільшення губ Neotiva — 29 вересня (вівторок) о 12:00",
            }),
            tool_call_id: "create",
            name: "create_meeting",
          }),
          new AIMessage(
            `Готово! Чекаємо вас на збільшення губ Neotiva 29 вересня (вівторок) о 12:00 ✨\n\n${CLINIC_ADDRESS}`,
          ),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toMatch(/^Готово! Запис створено\./);
    expect(update.lastHandoff?.replyText).toContain("Збільшення губ Neotiva");
    expect(update.lastHandoff?.replyText).toContain("29 вересня");
    expect(update.lastHandoff?.replyText).not.toContain("Найближчі вільні дні");
    expect(update.lastHandoff?.replyButtons).toEqual([...DEFAULT_MENU_HAS_VISITS]);
  });

  it("prefixes DATE offer when create_meeting overlaps and slots ran same turn", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const days = [
      {
        date: "2026-09-15",
        dayLabel: "15 вересня (вівторок)",
        slots: [
          {
            id: "a",
            label: "11:00",
            dateStart: "2026-09-15T11:00:00",
            dateEnd: "2026-09-15T11:30:00",
          },
          {
            id: "b",
            label: "14:30",
            dateStart: "2026-09-15T14:30:00",
            dateEnd: "2026-09-15T15:00:00",
          },
        ],
      },
      {
        date: "2026-09-28",
        dayLabel: "28 вересня (понеділок)",
        slots: [
          {
            id: "c",
            label: "11:00",
            dateStart: "2026-09-28T11:00:00",
            dateEnd: "2026-09-28T11:30:00",
          },
        ],
      },
    ];
    const update = await finalize(
      clinicState({
        stepCount: 3,
        availabilityContext: { days, stepMinutes: 30 },
        agentMessages: [
          runtimeToolAi([
              { id: "create", name: "create_meeting", args: {} },
              { id: "slots", name: "present_availability_slots", args: {} },
            ]),
          new ToolMessage({
            content: JSON.stringify({
              error: "This meeting overlaps an existing meeting for the assigned user.",
            }),
            tool_call_id: "create",
            name: "create_meeting",
          }),
          new ToolMessage({
            content: JSON.stringify({ days, stepMinutes: 30 }),
            tool_call_id: "slots",
            name: "present_availability_slots",
          }),
          new AIMessage(
            "На жаль, обраний час щойно зайняли.\n\nОсь інші дні з вигаданими годинами 09:00–18:00.",
          ),
        ],
      }),
    );

    const text = update.lastHandoff?.replyText ?? "";
    expect(text).toContain("Не вдалося створити запис");
    expect(text).not.toContain("Готово");
  });

  it("prefixes TIME offer when create_meeting overlaps and same-day slots ran this turn", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const day = {
      date: "2026-09-15",
      dayLabel: "15 вересня (вівторок)",
      slots: [
        {
          id: "2026-09-15T1430",
          label: "14:30",
          dateStart: "2026-09-15T14:30:00",
          dateEnd: "2026-09-15T15:00:00",
        },
      ],
    };
    const update = await finalize(
      clinicState({
        stepCount: 3,
        availabilityContext: { days: [day], stepMinutes: 30 },
        agentMessages: [
          new HumanMessage("11:00"),
          runtimeToolAi([{ id: "create", name: "create_meeting", args: {} }]),
          new ToolMessage({
            content: JSON.stringify({
              error: "This meeting overlaps an existing meeting for the assigned user.",
              hint: "That time may already be booked.",
            }),
            tool_call_id: "create",
            name: "create_meeting",
          }),
          runtimeToolAi([
              { id: "slots", name: "present_availability_slots", args: { date: "2026-09-15" } },
            ]),
          new ToolMessage({
            content: JSON.stringify({
              slots: day.slots,
              date: day.date,
              dayLabel: day.dayLabel,
              stepMinutes: 30,
            }),
            tool_call_id: "slots",
            name: "present_availability_slots",
          }),
          new AIMessage(
            "На жаль, 15 вересня о 11:00 вже зайнято. Залишився вільний час на цей день:\n\n  - 14:30\n\nБажаєте обрати цей час?",
          ),
        ],
      }),
    );

    const text = update.lastHandoff?.replyText ?? "";
    expect(text).toContain("Не вдалося створити запис");
    expect(text).not.toContain("Готово");
  });

  it("delivers model-failure fallback via handoff only (no history, no sticky ok)", async () => {
    const { createAgentLlmNode } = await import("../agent-loop/index.js");
    const { PATIENT_FALLBACK_MESSAGE } = await import("../../shared/clinic-constants.js");
    const bindTools = vi.fn(() => ({
      invoke: vi.fn(async () => {
        throw new Error("model down");
      }),
    }));
    const model = { bindTools } as unknown as BaseChatModel;
    const llm = createAgentLlmNode({
      agent,
      model,
      tools: [],
      formatSystemMetadata: () => "DYN",
    });
    const llmUpdate = await llm(
      clinicState({ agentMessages: [new HumanMessage("hi")], next: "booking" }),
    );
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: llmUpdate.stepCount ?? 1,
        agentMessages: llmUpdate.agentMessages as never,
      }),
    );

    expect(update.messages).toBeUndefined();
    expect(update.lastHandoff).toMatchObject({
      agentId: "booking",
      status: "error",
      replyText: PATIENT_FALLBACK_MESSAGE,
      replyButtons: ["Записатись", "Послуги", "Адреса"],
    });
  });

  it("code-owns FAQ consultation yield and BOOKING OFFER on «Послуги» without tags", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Послуги")],
        servicesContext: {
          list: [{ id: CONSULTATION_SERVICE_ID, name: "Консультація" }],
        },
        agentMessages: [new AIMessage("У нашій клініці доступні такі напрями:\n\n• Консультації")],
      }),
    );

    expect(update.lastHandoff).toMatchObject({
      agentId: "faq",
      status: "ok",
      replyButtons: [...BOOKING_OFFER_MENU],
      yieldToSupervisor: true,
    });
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
    expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance?.status).toBe("pending");
  });

  it("does not open a consultation offer from consultation prose alone", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("запиши на консультацію")],
        servicesContext: {
          list: [{ id: CONSULTATION_SERVICE_ID, name: "Консультація" }],
        },
        agentMessages: [new AIMessage("Записати вас на консультацію?")],
      }),
    );

    expect(unwrapCommandUpdate(update).pendingInteraction?.kind ?? null).not.toBe("service_confirm");
    expect(unwrapCommandUpdate(update).bookingDraft?.serviceAcceptance ?? null).toBeNull();
  });

  it("stores yieldToSupervisor and strips the yield tag from checkpointed history", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        messages: [new HumanMessage("Послуги")],
        servicesContext: {
          list: [{ id: CONSULTATION_SERVICE_ID, name: "Консультація" }],
        },
        agentMessages: [
          new AIMessage(
            "У нашій клініці доступні такі напрями:\n\n• Консультації\n<yield_to_supervisor/>\n<reply_buttons>\nТак\nОбрати іншу процедуру\n</reply_buttons>",
          ),
        ],
      }),
    );

    const stored = update.messages?.[0] as AIMessage;
    expect(String(stored.content)).not.toContain("yield_to_supervisor");
    expect(String(stored.content)).not.toContain("reply_buttons");
    expect(update.lastHandoff).toMatchObject({
      agentId: "faq",
      status: "ok",
      replyButtons: [...BOOKING_OFFER_MENU],
      yieldToSupervisor: true,
    });
    expect(unwrapCommandUpdate(update).pendingInteraction?.kind).toBe("service_confirm");
  });

  it("strips a yield-only trailer and omits DEFAULT MENU for faq", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        bookingContext: makeListedMeetings(),
        agentMessages: [new AIMessage("Done.\n<yield_to_supervisor/>")],
      }),
    );

    const stored = update.messages?.[0] as AIMessage;
    expect(String(stored.content)).toBe("Done.");
    expect(String(stored.content)).not.toContain("yield_to_supervisor");
    expect(update.lastHandoff).toMatchObject({
      agentId: "faq",
      status: "ok",
      replyText: "Done.",
      yieldToSupervisor: true,
    });
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  it("does not attach buttons for faq location-only replies", async () => {
    const faqAgent: ClinicAgentDefinition = {
      id: "faq",
      name: "FAQ",
      description: "Answers FAQ",
      systemPrompt: "faq",
      maxSteps: 4,
    };
    const finalize = createFaqFinalizeNode(faqAgent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        agentMessages: [
          new AIMessage(`Ми знаходимося за адресою ${CLINIC_ADDRESS}.`),
        ],
      }),
    );

    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });

  const moveSnapshot: AvailabilityContext = {
    days: [
      {
        date: "2026-09-10",
        dayLabel: "10 вересня (четвер)",
        slots: [
          {
            id: "2026-09-10T1400",
            label: "14:00",
            dateStart: "2026-09-10T14:00:00",
            dateEnd: "2026-09-10T15:00:00",
          },
        ],
      },
      {
        date: "2026-09-11",
        dayLabel: "11 вересня (п'ятниця)",
        slots: [
          {
            id: "2026-09-11T1200",
            label: "12:00",
            dateStart: "2026-09-11T12:00:00",
            dateEnd: "2026-09-11T13:00:00",
          },
        ],
      },
      {
        date: "2026-09-12",
        dayLabel: "12 вересня (субота)",
        slots: [
          {
            id: "2026-09-12T1100",
            label: "11:00",
            dateStart: "2026-09-12T11:00:00",
            dateEnd: "2026-09-12T12:00:00",
          },
        ],
      },
    ],
    stepMinutes: 60,
    excludeMeetingIds: ["6a95fe6e5b90474bc"],
  };

  it("replaces invented 09:00–18:00 with DATE offer (hours in text, date keyboard)", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 2,
        availabilityContext: moveSnapshot,
        bookingDraft: reduceBookingDraft(createEmptyBookingDraft(), {
          type: "reschedule_started",
          meeting: { id: "6a95fe6e5b90474bc", name: "Visit" },
        }),
        agentMessages: [
          new HumanMessage("Перенести"),
          runtimeToolAi([{ id: "1", name: "present_availability_slots", args: {} }]),
          new ToolMessage({
            content: JSON.stringify({
              date: "2026-09-10",
              slots: moveSnapshot.days[0]!.slots,
              days: moveSnapshot.days,
              stepMinutes: 60,
              searchedDays: 12,
              excludeMeetingIds: moveSnapshot.excludeMeetingIds,
            }),
            tool_call_id: "1",
            name: "present_availability_slots",
          }),
          new AIMessage(
            "Вільні години на 10 вересня (четвер) 🗓️\n\n  - 09:00\n  - 10:00\n  - 11:00\n  - 12:00\n  - 13:00\n  - 14:00\n  - 15:00\n  - 16:00\n  - 17:00\n  - 18:00\n\nЯкий час вам зручний?",
          ),
        ],
      }),
    );

    const text = update.lastHandoff?.replyText ?? "";
    expect(text).toContain("10 вересня (четвер): 14:00");
    expect(text).toContain("11 вересня (п'ятниця): 12:00");
    expect(text).toContain("12 вересня (субота): 11:00");
    expect(text).not.toContain("18:00");
    expect(text).not.toContain("09:00");
    expect(update.lastHandoff?.replyButtons).toEqual([
      "10 вересня",
      "11 вересня",
      "12 вересня",
      OTHER_DATE_LABEL,
    ]);
    expect(String(update.messages?.[0]?.content)).toBe(text);
  });

  it("on day pick without a new tool call, rewrites to TIME from availabilityContext", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        availabilityContext: moveSnapshot,
        bookingDraft: reduceBookingDraft(createEmptyBookingDraft(), {
          type: "reschedule_started",
          meeting: { id: "6a95fe6e5b90474bc", name: "Visit" },
        }),
        agentMessages: [
          new HumanMessage("10 вересня"),
          new AIMessage(
            "Вільні години на 10 вересня (четвер) 🗓️\n\n  - 09:00\n  - 10:00\n  - 18:00\n\nЯкий час вам зручний?",
          ),
        ],
      }),
    );

    const text = update.lastHandoff?.replyText ?? "";
    expect(text).toContain("Вільні години на 10 вересня (четвер)");
    expect(text).toContain("14:00");
    expect(text).not.toContain("18:00");
    expect(text).not.toContain("09:00");
    expect(update.lastHandoff?.replyButtons).toEqual(["14:00", OTHER_DATE_LABEL]);
  });

  it("omits DEFAULT MENU when availability snapshot is empty and there is no trailer", async () => {
    const finalize = createBookingFinalizeNode(agent);
    const update = await finalize(
      clinicState({
        stepCount: 1,
        availabilityContext: { days: [], stepMinutes: 60 },
        agentMessages: [
          new HumanMessage("Записатись"),
          new AIMessage("Could you please provide your phone number?"),
        ],
      }),
    );

    expect(update.lastHandoff?.replyText).toBe("Could you please provide your phone number?");
    expect(update.lastHandoff?.replyButtons).toBeUndefined();
  });
});


describe("replacement offer menu precedence", () => {
  const agent: ClinicAgentDefinition = {
    id: "booking",
    name: "Booking",
    description: "Books visits",
    systemPrompt: "book",
    maxSteps: 8,
  };

  it("keeps replacement consent buttons when the note step is still awaiting", async () => {
    const update = await createBookingFinalizeNode(agent)(clinicState({
      bookingDraft: {
        version: 3,
        mode: "replace",
        phase: "confirming",
        serviceAcceptance: {
          status: "accepted",
          service: { id: CONSULTATION_SERVICE_ID, source: "catalog" },
        },
        availability: null,
        selectedDate: "2026-09-10",
        selectedSlot: {
          dateStart: "2026-09-10T14:00:00",
          dateEnd: "2026-09-10T14:30:00",
          label: "14:00",
        },
        note: { status: "awaiting" },
        contactId: "c-1",
        pendingCommand: null,
        replacement: {
          meeting: { id: "existing-1", name: "Existing visit" },
          status: "offered",
        },
      },
      agentMessages: [new AIMessage("Поточний запис заважає створити новий. Бажаєте замінити його?")],
    }));

    expect(update.lastHandoff?.replyButtons).toEqual([...BOOKING_REPLACE_MENU]);
    expect(update.lastHandoff?.replyButtons).not.toContain(INTENT_SKIP_LABEL);
  });
});


