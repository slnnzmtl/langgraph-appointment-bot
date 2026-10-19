import { describe, expect, it } from "vitest";

import {
  assertBoundAgentToolNames,
  assertBookingRuntimeToolNames,
} from "../../graph/bound-tools.js";
import {
  BOOKING_RUNTIME_TOOL_NAMES,
  createBookingTools,
  createReadTools,
  filterBookingInformationalTools,
} from "../index.js";

describe("clinic-tools composition", () => {
  const callTool = async () => ({ ok: true });

  it("booking tools combine contact and meeting tools and exclude FAQ-only tools", () => {
    const names = createBookingTools({ callTool, assignedUserId: "user-1" }).map((t) => t.name);
    expect(names).toEqual([
      "find_contact_by_phone",
      "create_contact",
      "link_telegram_to_contact",
      "update_contact",
      "present_availability_slots",
      "create_meeting",
      "list_planned_meetings",
      "cancel_meeting",
      "reschedule_meeting",
    ]);
    expect(names).not.toContain("list_services");
    expect(names).not.toContain("get_service");
  });

  it("booking LLM surface is FAQ reads only; runtime tools stay executable", () => {
    const readTools = createReadTools({ callTool, assignedUserId: "user-1" });
    const bookingTools = createBookingTools({ callTool, assignedUserId: "user-1" });
    const full = [...readTools, ...bookingTools];
    const informational = filterBookingInformationalTools(full).map((t) => t.name);
    expect(informational).toEqual(["list_services", "get_service", "get_working_time"]);
    for (const name of BOOKING_RUNTIME_TOOL_NAMES) {
      expect(informational).not.toContain(name);
      expect(full.some((tool) => tool.name === name)).toBe(true);
    }
  });

  it("keeps unknown booking tools off the LLM surface by default", () => {
    const informational = filterBookingInformationalTools([
      { name: "list_services" },
      { name: "create_meeting_v2" },
      { name: "get_working_time" },
    ] as never).map((tool) => tool.name);
    expect(informational).toEqual(["list_services", "get_working_time"]);
  });

  it("assertBoundAgentToolNames accepts informational binds and rejects runtime leaks", () => {
    const readTools = createReadTools({ callTool, assignedUserId: "user-1" });
    expect(() => assertBoundAgentToolNames("booking", readTools)).not.toThrow();
    expect(() => assertBoundAgentToolNames("faq", readTools)).not.toThrow();

    const bookingTools = createBookingTools({ callTool, assignedUserId: "user-1" });
    expect(() => assertBoundAgentToolNames("booking", bookingTools)).toThrow(
      /non-informational tools/,
    );
    expect(() => assertBoundAgentToolNames("faq", bookingTools)).toThrow(
      /runtime-owned tools/,
    );
  });

  it("assertBookingRuntimeToolNames accepts ToolNode runtime+informational set", () => {
    const readTools = createReadTools({ callTool, assignedUserId: "user-1" });
    const bookingTools = createBookingTools({ callTool, assignedUserId: "user-1" });
    expect(() => assertBookingRuntimeToolNames([...readTools, ...bookingTools])).not.toThrow();
    expect(() =>
      assertBookingRuntimeToolNames([
        ...readTools,
        ...bookingTools,
        { name: "invented_tool" } as never,
      ]),
    ).toThrow(/unknown tools/);
  });
});
