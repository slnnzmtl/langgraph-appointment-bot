import { ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import type { PendingEffect } from "../../booking-domain/effects.js";
import {
  allowlistedInformationalFacts,
  effectResultFromToolMessages,
} from "../booking-decide-nodes.js";

const createMeetingPending = (id: string): PendingEffect => ({
  id,
  expectedRevision: 1,
  effect: {
    kind: "create_meeting",
    payload: {
      serviceId: "svc-1",
      contactId: "c-1",
      dateStart: "2026-10-20T11:30:00",
      dateEnd: "2026-10-20T12:00:00",
      name: "Botox - Test",
      confirmMessage: "Підтвердити запис?",
    },
  },
  status: "executing",
});

describe("allowlisted informational facts", () => {
  it("keeps only hours/address/servicePrice and drops raw text keys", () => {
    const facts = allowlistedInformationalFacts({
      hours: "Пн–Пт 09:00–18:00",
      address: "вул. Прикладна 1",
      servicePrice: "1200",
      secretPatientNote: "do not leak",
      rawDump: "full tool body",
    });
    expect(facts).toEqual({
      hours: "Пн–Пт 09:00–18:00",
      address: "вул. Прикладна 1",
      servicePrice: "1200",
    });
    expect(facts).not.toHaveProperty("secretPatientNote");
    expect(facts).not.toHaveProperty("rawDump");
  });

  it("maps get_working_time tool JSON into allowlisted facts without raw body", () => {
    const result = effectResultFromToolMessages(
      [
        new ToolMessage({
          content: JSON.stringify({
            hours: "09:00-18:00",
            address: "Kyiv",
            internalTrace: "PII-or-prompt",
          }),
          tool_call_id: "eff_1_get_working_time",
          name: "get_working_time",
        }),
      ],
      {
        id: "eff_1_get_working_time",
        expectedRevision: 1,
        effect: { kind: "get_working_time" },
        status: "prepared",
      },
    );
    expect(result).toMatchObject({
      kind: "informational",
      outcome: "ok",
      facts: { hours: "09:00-18:00", address: "Kyiv" },
    });
    expect(JSON.stringify(result)).not.toContain("internalTrace");
    expect(JSON.stringify(result)).not.toContain("PII-or-prompt");
  });
});

describe("effectResultFromToolMessages meeting mutation", () => {
  it("stamps { cancelled, left } as declined (HITL main-menu leave)", () => {
    const id = "eff_1_create_meeting";
    const result = effectResultFromToolMessages(
      [
        new ToolMessage({
          content: JSON.stringify({
            cancelled: true,
            left: true,
            message: "Cancelled by user.",
          }),
          tool_call_id: id,
          name: "create_meeting",
        }),
      ],
      createMeetingPending(id),
    );
    expect(result).toEqual({
      effectId: id,
      kind: "mutation",
      action: "create",
      outcome: "declined",
    });
  });

  it("stamps { cancelled } as declined (HITL ❌)", () => {
    const id = "eff_2_create_meeting";
    const result = effectResultFromToolMessages(
      [
        new ToolMessage({
          content: JSON.stringify({
            cancelled: true,
            message: "Cancelled by user.",
          }),
          tool_call_id: id,
          name: "create_meeting",
        }),
      ],
      createMeetingPending(id),
    );
    expect(result).toEqual({
      effectId: id,
      kind: "mutation",
      action: "create",
      outcome: "declined",
    });
  });
});

describe("effectResultFromToolMessages list_services catalog", () => {
  it("parses catalog JSON that contains escaped newlines in descriptions", () => {
    const id = "eff_22_list_services";
    // CRM descriptions often embed \\n; unescapeModelLineBreaks would corrupt this.
    const content = JSON.stringify({
      list: [
        {
          id: "svc-1",
          name: "Корекція ботокс",
          description: "Line A\nLine B\nLine C",
        },
        {
          id: "svc-2",
          name: "Мезоботокс",
          description: "Neuvia\nCollevia\nDives",
        },
      ],
      total: 2,
    });
    expect(content).toContain("\\n");
    const result = effectResultFromToolMessages(
      [
        new ToolMessage({
          content,
          tool_call_id: id,
          name: "list_services",
        }),
      ],
      {
        id,
        expectedRevision: 22,
        effect: { kind: "list_services", query: "ботокс" },
        status: "executing",
      },
    );
    expect(result).toEqual({
      effectId: id,
      kind: "catalog",
      outcome: "ok",
      services: [
        { id: "svc-1", name: "Корекція ботокс" },
        { id: "svc-2", name: "Мезоботокс" },
      ],
    });
  });
});
