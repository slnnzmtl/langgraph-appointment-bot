import { describe, expect, it, vi } from "vitest";

import {
  createCleanupRegistry,
  detectDeleteEntitySupport,
  entityIdFromResult,
  retiredTelegramId,
  trackIdsFromCallResult,
} from "../cleanup.js";

describe("cleanup registry", () => {
  it("keeps retired cTelegram under CRM maxLength", () => {
    expect(retiredTelegramId("6ac918899134d2adf")).toBe("x134d2adf");
    expect(retiredTelegramId("6ac918899134d2adf").length).toBeLessThanOrEqual(10);
  });

  it("parses entity ids from create results", () => {
    expect(entityIdFromResult({ id: "m-1" })).toBe("m-1");
    expect(entityIdFromResult({ meetingId: "m-2" })).toBe("m-2");
    expect(entityIdFromResult('{"id":"m-3"}')).toBe("m-3");
    expect(entityIdFromResult("Successfully created meeting with ID: m-4")).toBe("m-4");
  });

  it("tracks create_meeting / create_contact and soft-cancels on run", async () => {
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "update_meeting") {
        return { ok: true };
      }
      if (name === "delete_entity") {
        return { ok: true };
      }
      throw new Error(`unexpected ${name} ${JSON.stringify(args)}`);
    });
    const cleanup = createCleanupRegistry(callTool, { supportsDeleteEntity: true });
    trackIdsFromCallResult(cleanup, "create_meeting", { id: "meet-1" });
    trackIdsFromCallResult(cleanup, "create_contact", { id: "contact-1" });
    expect([...cleanup.meetingIds]).toEqual(["meet-1"]);
    expect([...cleanup.contactIds]).toEqual(["contact-1"]);

    await cleanup.run();
    expect(callTool).toHaveBeenCalledWith("update_meeting", {
      meetingId: "meet-1",
      status: "Not Held",
    });
    expect(callTool).toHaveBeenCalledWith("delete_entity", {
      entityType: "Meeting",
      entityId: "meet-1",
    });
    expect(callTool).toHaveBeenCalledWith("delete_entity", {
      entityType: "Contact",
      entityId: "contact-1",
    });
    expect(cleanup.meetingIds.size).toBe(0);
  });

  it("scrubs contact identity when delete_entity is unsupported", async () => {
    const callTool = vi.fn(async (name: string) => {
      if (name === "update_meeting" || name === "update_entity") {
        return { ok: true };
      }
      throw new Error(`unexpected ${name}`);
    });
    const cleanup = createCleanupRegistry(callTool, { supportsDeleteEntity: false });
    cleanup.trackMeeting("meet-9");
    cleanup.trackContact("contact-9");
    await cleanup.run();
    expect(callTool).toHaveBeenCalledWith("update_meeting", {
      meetingId: "meet-9",
      status: "Not Held",
    });
    expect(callTool).toHaveBeenCalledWith("update_entity", {
      entityType: "Contact",
      entityId: "contact-9",
      data: {
        phoneNumber: "",
        cTelegram: "xcontact9",
      },
    });
  });

  it("detectDeleteEntitySupport is false on No delete access", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("No delete access.");
    });
    await expect(detectDeleteEntitySupport(callTool)).resolves.toBe(false);
  });

  it("detectDeleteEntitySupport is true when the probe entity is not found", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("Record not found");
    });
    await expect(detectDeleteEntitySupport(callTool)).resolves.toBe(true);
  });

  it("detectDeleteEntitySupport is false when delete_entity tool is missing", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("Unknown tool: delete_entity");
    });
    await expect(detectDeleteEntitySupport(callTool)).resolves.toBe(false);
  });
});
