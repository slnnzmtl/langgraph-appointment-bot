import { describe, expect, it } from "vitest";

import { createBookingTools } from "../index.js";

describe("clinic-tools composition", () => {
  const callTool = async () => ({ ok: true });

  it("booking tools combine contact and meeting tools and exclude FAQ-only tools", () => {
    const names = createBookingTools({ callTool, assignedUserId: "user-1" }).map((t) => t.name);
    expect(names).toEqual([
      "find_contact_by_telegram",
      "find_contact_by_phone",
      "create_contact",
      "link_telegram_to_contact",
      "present_availability_slots",
      "create_meeting",
      "list_planned_meetings",
      "cancel_meeting",
      "reschedule_meeting",
    ]);
    expect(names).not.toContain("list_services");
    expect(names).not.toContain("get_service");
  });
});
