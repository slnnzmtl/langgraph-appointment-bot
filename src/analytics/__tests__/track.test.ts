import { afterEach, describe, expect, it } from "vitest";

import { runWithTelegramUserId } from "../../tools/telegram-user-context.js";
import {
  finishTrackedWrite,
  setTrackEventForTests,
  toolErrorJson,
  trackEvent,
  type Tier1EventName,
} from "../track.js";

type Captured = { name: Tier1EventName; props: Record<string, unknown> };

describe("trackEvent", () => {
  const originalDisabled = process.env.ANALYTICS_DISABLED;

  afterEach(() => {
    setTrackEventForTests(null);
    if (originalDisabled === undefined) {
      delete process.env.ANALYTICS_DISABLED;
    } else {
      process.env.ANALYTICS_DISABLED = originalDisabled;
    }
  });

  it("captures via test hook", () => {
    const seen: Captured[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    trackEvent("contact_created", { contact_id: "c-1" });
    expect(seen).toEqual([{ name: "contact_created", props: { contact_id: "c-1" } }]);
  });

  it("accepts reply_menu_filled as a Tier1 event", () => {
    const seen: Captured[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    trackEvent("reply_menu_filled", { menu: "visit_change", reason: "omitted" });
    trackEvent("reply_menu_filled", { menu: "booking_offer", reason: "omitted" });
    trackEvent("reply_menu_filled", { menu: "default", reason: "idle" });
    expect(seen).toEqual([
      { name: "reply_menu_filled", props: { menu: "visit_change", reason: "omitted" } },
      { name: "reply_menu_filled", props: { menu: "booking_offer", reason: "omitted" } },
      { name: "reply_menu_filled", props: { menu: "default", reason: "idle" } },
    ]);
  });

  it("accepts booking note and slots cache Tier1 events", () => {
    const seen: Captured[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    trackEvent("availability_cache_hit", { outcome: "success", kind: "date_list" });
    trackEvent("booking_note_step", { phase: "awaiting" });
    trackEvent("booking_create_blocked_note", { phase: "unasked" });
    expect(seen.map((entry) => entry.name)).toEqual([
      "availability_cache_hit",
      "booking_note_step",
      "booking_create_blocked_note",
    ]);
  });

  it("accepts reminder_sent as a Tier1 event", () => {
    const seen: Captured[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    trackEvent("reminder_sent", {
      outcome: "success",
      telegram_user_id: "42",
      meeting_count: 1,
      hitl: false,
      meeting_ids: [],
    });
    expect(seen).toEqual([
      {
        name: "reminder_sent",
        props: {
          outcome: "success",
          telegram_user_id: "42",
          meeting_count: 1,
          hitl: false,
          meeting_ids: [],
        },
      },
    ]);
  });

  it("accepts reminder_approved and reminder_declined as Tier1 events", () => {
    const seen: Captured[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    trackEvent("reminder_approved", {
      outcome: "success",
      telegram_user_id: "42",
      meeting_count: 1,
      meeting_ids: ["meet-1"],
    });
    trackEvent("reminder_declined", {
      outcome: "success",
      telegram_user_id: "42",
      meeting_count: 2,
      meeting_ids: ["meet-2", "meet-3"],
    });
    expect(seen).toEqual([
      {
        name: "reminder_approved",
        props: {
          outcome: "success",
          telegram_user_id: "42",
          meeting_count: 1,
          meeting_ids: ["meet-1"],
        },
      },
      {
        name: "reminder_declined",
        props: {
          outcome: "success",
          telegram_user_id: "42",
          meeting_count: 2,
          meeting_ids: ["meet-2", "meet-3"],
        },
      },
    ]);
  });

  it("no-ops when ANALYTICS_DISABLED=1", () => {
    process.env.ANALYTICS_DISABLED = "1";
    const seen: Captured[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    trackEvent("contact_created", { contact_id: "c-1" });
    expect(seen).toEqual([]);
  });

  it("does not throw when tracing is off and no spy is set", () => {
    expect(() => trackEvent("contact_created", { contact_id: "c-1" })).not.toThrow();
  });

  it("merges telegram_user_id from ALS", () => {
    const seen: Captured[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    runWithTelegramUserId("tg-42", () => {
      trackEvent("contact_created", { contact_id: "c-1" });
    });
    expect(seen[0]?.props).toMatchObject({
      telegram_user_id: "tg-42",
      contact_id: "c-1",
    });
  });
});

describe("finishTrackedWrite / toolErrorJson", () => {
  afterEach(() => {
    setTrackEventForTests(null);
  });

  it("calls onSuccess with entity id", () => {
    const seen: Captured[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    const ids: Array<string | undefined> = [];
    const raw = finishTrackedWrite("create_contact", '{"id":"c-1"}', (id) => {
      ids.push(id);
    });
    expect(raw).toBe('{"id":"c-1"}');
    expect(ids).toEqual(["c-1"]);
    expect(seen).toEqual([]);
  });

  it("emits tool_error on error JSON and skips onSuccess", () => {
    const seen: Captured[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    let called = false;
    finishTrackedWrite("create_contact", '{"error":"CRM down"}', () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(seen).toContainEqual(
      expect.objectContaining({
        name: "tool_error",
        props: expect.objectContaining({ tool: "create_contact", error_message: "CRM down" }),
      }),
    );
  });

  it("skips tracking when skip matches HITL pending", () => {
    const seen: Captured[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    let called = false;
    finishTrackedWrite(
      "create_meeting",
      '{"cancelled":true}',
      () => {
        called = true;
      },
      { skip: (record) => record.cancelled === true },
    );
    expect(called).toBe(false);
    expect(seen).toEqual([]);
  });

  it("toolErrorJson tracks and returns error JSON", () => {
    const seen: Captured[] = [];
    setTrackEventForTests((name, props) => {
      seen.push({ name, props });
    });
    expect(JSON.parse(toolErrorJson("create_contact", new Error("boom")))).toEqual({
      error: "boom",
    });
    expect(seen[0]).toMatchObject({
      name: "tool_error",
      props: expect.objectContaining({ tool: "create_contact", error_message: "boom" }),
    });
  });
});
