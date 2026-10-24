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
          duration: 60,
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
        { id: "svc-1", name: "Корекція ботокс", durationMinutes: 60 },
        { id: "svc-2", name: "Мезоботокс" },
      ],
    });
  });

  it("keeps catalog rows beyond the 60-row servicesContext cap", () => {
    const id = "eff_65_list_services";
    const list = Array.from({ length: 65 }, (_, index) => ({
      id: `svc-${index}`,
      name: `Service ${index}`,
    }));
    const result = effectResultFromToolMessages(
      [
        new ToolMessage({
          content: JSON.stringify({ list, total: 65 }),
          tool_call_id: id,
          name: "list_services",
        }),
      ],
      {
        id,
        expectedRevision: 1,
        effect: { kind: "list_services", query: "ботокс" },
        status: "executing",
      },
    );
    expect(result?.kind).toBe("catalog");
    expect(result?.kind === "catalog" ? result.services : []).toHaveLength(65);
    expect(result?.kind === "catalog" ? result.services?.[64] : undefined).toEqual({
      id: "svc-64",
      name: "Service 64",
    });
  });

  it("fails closed when list_services total exceeds returned rows", () => {
    const id = "eff_partial_list_services";
    const list = Array.from({ length: 200 }, (_, index) => ({
      id: `svc-${index}`,
      name: `Service ${index}`,
    }));
    const result = effectResultFromToolMessages(
      [
        new ToolMessage({
          content: JSON.stringify({ list, total: 350 }),
          tool_call_id: id,
          name: "list_services",
        }),
      ],
      {
        id,
        expectedRevision: 1,
        effect: { kind: "list_services" },
        status: "executing",
      },
    );
    expect(result).toEqual({
      effectId: id,
      kind: "catalog",
      outcome: "error",
    });
  });
});

describe("effectResultFromToolMessages verified Contact update", () => {
  it("derives completeness from the verified contact row, not missingFields metadata", () => {
    const id = "eff_8_update_contact";
    const result = effectResultFromToolMessages(
      [new ToolMessage({
        content: JSON.stringify({
          success: true,
          id: "c-owned",
          contactId: "c-owned",
          firstName: "Ada",
          lastName: "Lovelace",
          phoneNumber: "+380501234567",
          missingFields: ["lastName"],
          injected: "discard",
        }),
        tool_call_id: id,
        name: "update_contact",
      })],
      {
        id,
        expectedRevision: 8,
        effect: { kind: "update_contact", payload: { contactId: "c-owned", lastName: "Lovelace" } },
        status: "executing",
      },
    );
    expect(result).toMatchObject({
      kind: "contact_write",
      outcome: "updated",
      contactId: "c-owned",
      crmComplete: true,
      contact: {
        id: "c-owned",
        firstName: "Ada",
        lastName: "Lovelace",
        phoneNumber: "+380501234567",
      },
    });
    expect(result && "contact" in result ? result.contact : undefined).not.toHaveProperty("injected");
  });

  it("rejects explicit errors and incomplete verified rows", () => {
    const id = "eff_9_update_contact";
    const pending: PendingEffect = {
      id,
      expectedRevision: 9,
      effect: { kind: "update_contact", payload: { contactId: "c-owned" } },
      status: "executing",
    };
    const failed = effectResultFromToolMessages(
      [new ToolMessage({ content: JSON.stringify({ success: true, id: "c-owned", error: "no" }), tool_call_id: id, name: "update_contact" })],
      pending,
    );
    expect(failed).toMatchObject({ kind: "contact_write", outcome: "failed" });
    const incomplete = effectResultFromToolMessages(
      [new ToolMessage({
        content: JSON.stringify({ success: true, id: "c-owned", contactId: "c-owned", firstName: "Ada", phoneNumber: "+380501234567" }),
        tool_call_id: id,
        name: "update_contact",
      })],
      pending,
    );
    expect(incomplete).toMatchObject({ kind: "contact_write", outcome: "updated", crmComplete: false });
  });
});


describe("availability effect completeness", () => {
  const pending: PendingEffect = {
    id: "eff_availability",
    expectedRevision: 1,
    effect: { kind: "present_availability", args: { direction: "exact", date: "2026-10-25" } },
    status: "executing",
  };
  const body = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    days: [{ date: "2026-10-25", slots: [{ id: "s1", label: "10:00", dateStart: "2026-10-25T10:00:00", dateEnd: "2026-10-25T10:30:00" }] }],
    query: { kind: "exact", date: "2026-10-25", coverageComplete: true },
    ...overrides,
  });
  const consume = (content: string) => effectResultFromToolMessages([
    new ToolMessage({
      content,
      tool_call_id: pending.id,
      name: "present_availability_slots",
    }),
  ], pending);

  it.each([
    ["nonempty truncated response", body({ truncated: true })],
    ["nonempty incomplete query", body({ query: { kind: "exact", date: "2026-10-25", coverageComplete: false } })],
    ["both incomplete markers", body({ truncated: true, query: { kind: "exact", date: "2026-10-25", coverageComplete: false } })],
    ["incomplete empty response", body({ days: [], truncated: true })],
  ])("rejects %s as trusted availability", (_name, content) => {
    expect(consume(content)).toMatchObject({ kind: "availability", outcome: "error" });
  });

  it("accepts complete empty responses as a trustworthy empty result", () => {
    expect(consume(body({ days: [] }))).toMatchObject({ kind: "availability", outcome: "empty" });
  });
});
