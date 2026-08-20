import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { setTrackEventForTests, type Tier1EventName } from "../../analytics/track.js";
import {
  annotateContactSearchResult,
  contactMissingFields,
  createContactTools,
  extractContactIdFromSearchResult,
  lookupContactByTelegram,
  normalizeContactLookupResult,
} from "../contact-tools.js";
import { runWithTelegramUserId } from "../telegram-user-context.js";

type CallRecord = { name: string; args: Record<string, unknown> };

const withTg = <T>(fn: () => Promise<T> | T): Promise<T> | T =>
  runWithTelegramUserId("tg-42", fn);

describe("contact-tools", () => {
  const calls: CallRecord[] = [];
  const events: Array<{ name: Tier1EventName; props: Record<string, unknown> }> = [];

  beforeEach(() => {
    calls.length = 0;
    events.length = 0;
    setTrackEventForTests((name, props) => {
      events.push({ name, props });
    });
  });

  afterEach(() => {
    setTrackEventForTests(null);
  });

  const callTool = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "create_contact") {
      return { success: true, id: "contact-1", cTelegram: args.cTelegram };
    }
    if (name === "update_entity") {
      return `Successfully updated Contact record with ID: ${args.entityId as string}`;
    }
    return { ok: true };
  };

  it("create_contact forces cTelegram from holder", async () => {
    await withTg(async () => {
      const [createContact] = createContactTools({ callTool }).filter(
        (tool) => tool.name === "create_contact",
      );

      expect(createContact).toBeDefined();
      const result = await createContact!.invoke({
        firstName: "Ada",
        lastName: "Lovelace",
        phoneNumber: "+380501112233",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        name: "create_contact",
        args: {
          firstName: "Ada",
          lastName: "Lovelace",
          phoneNumber: "+380501112233",
          cTelegram: "tg-42",
          skipDuplicateCheck: true,
        },
      });
      expect(JSON.parse(result as string)).toMatchObject({ cTelegram: "tg-42" });
      expect(events).toContainEqual(
        expect.objectContaining({
          name: "contact_created",
          props: expect.objectContaining({ contact_id: "contact-1" }),
        }),
      );
    });
  });

  it("create_contact normalizes local UA phone to E.164", async () => {
    await withTg(async () => {
      const [createContact] = createContactTools({ callTool }).filter(
        (tool) => tool.name === "create_contact",
      );
      await createContact!.invoke({
        firstName: "Тест",
        lastName: "Тестовий",
        phoneNumber: "0501838282",
      });
      expect(calls[0]?.args.phoneNumber).toBe("+380501838282");
    });
  });

  it("create_contact omits blank phone and still calls MCP", async () => {
    await withTg(async () => {
      const [createContact] = createContactTools({ callTool }).filter(
        (tool) => tool.name === "create_contact",
      );
      await createContact!.invoke({ firstName: "Ada", phoneNumber: "  " });
      expect(calls[0]?.args).not.toHaveProperty("phoneNumber");
    });
  });

  it("invalid phone returns error and does not call MCP", async () => {
    await withTg(async () => {
      const tools = createContactTools({ callTool });
      const find = tools.find((tool) => tool.name === "find_contact_by_phone");
      const update = tools.find((tool) => tool.name === "update_contact");
      const create = tools.find((tool) => tool.name === "create_contact");

      await expect(find!.invoke({ phoneNumber: "garbage" })).rejects.toThrow(
        /Could not parse phone number/,
      );
      await expect(update!.invoke({ contactId: "c-99", phoneNumber: "123" })).rejects.toThrow(
        /Could not parse phone number/,
      );
      await expect(create!.invoke({ firstName: "Ada", phoneNumber: "garbage" })).rejects.toThrow(
        /Could not parse phone number/,
      );

      expect(calls).toHaveLength(0);
    });
  });

  it("update_contact writes name and phone via update_entity", async () => {
    const [update] = createContactTools({ callTool }).filter((tool) => tool.name === "update_contact");

    expect(update).toBeDefined();
    await update!.invoke({
      contactId: "c-99",
      firstName: "Ada",
      lastName: "Lovelace",
      phoneNumber: "+380501112233",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      name: "update_entity",
      args: {
        entityType: "Contact",
        entityId: "c-99",
        data: {
          firstName: "Ada",
          lastName: "Lovelace",
          phoneNumber: "+380501112233",
        },
      },
    });
  });

  it("link_telegram_to_contact writes holder id via update_entity", async () => {
    await withTg(async () => {
      const [link] = createContactTools({ callTool }).filter(
        (tool) => tool.name === "link_telegram_to_contact",
      );

      expect(link).toBeDefined();
      await link!.invoke({ contactId: "c-99" });

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        name: "update_entity",
        args: {
          entityType: "Contact",
          entityId: "c-99",
          data: { cTelegram: "tg-42" },
        },
      });
    });
  });

  it("lookupContactByTelegram uses holder id", async () => {
    await withTg(async () => {
      await lookupContactByTelegram(callTool);

      expect(calls[0]).toEqual({
        name: "search_contacts",
        args: { cTelegram: "tg-42", limit: 5 },
      });
    });
  });

  it("contactMissingFields treats null and blank as missing", () => {
    expect(
      contactMissingFields({
        firstName: "Daniel",
        lastName: null,
        phoneNumber: "+380501234567",
      }),
    ).toEqual(["lastName"]);
    expect(
      contactMissingFields({
        firstName: "Ada",
        lastName: "  ",
        phoneNumber: "+380501112233",
      }),
    ).toEqual(["lastName"]);
    expect(
      contactMissingFields({
        firstName: "Ada",
        lastName: "Lovelace",
        phoneNumber: "+380501112233",
      }),
    ).toEqual([]);
  });

  it("annotateContactSearchResult flags lastName null", () => {
    const raw = {
      success: true,
      total: 1,
      contacts: [
        {
          id: "686f75c23dc0601e8",
          firstName: "Daniel",
          lastName: null,
          phoneNumber: "+380501234567",
        },
      ],
    };
    expect(JSON.parse(annotateContactSearchResult(raw))).toMatchObject({
      contacts: [{ missingFields: ["lastName"] }],
    });
  });

  it("find_contact_by_phone annotates missingFields", async () => {
    const phoneCallTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return {
        success: true,
        contacts: [{ id: "c-1", firstName: "Ada", lastName: null, phoneNumber: args.phoneNumber }],
      };
    };
    const [find] = createContactTools({ callTool: phoneCallTool }).filter(
      (tool) => tool.name === "find_contact_by_phone",
    );
    const result = await find!.invoke({ phoneNumber: "+380501112233" });
    expect(JSON.parse(result as string)).toMatchObject({
      contacts: [{ missingFields: ["lastName"] }],
    });
  });

  it("lookupContactByTelegram uses holder id and returns JSON", async () => {
    await withTg(async () => {
      const result = await lookupContactByTelegram(callTool);
      expect(calls[0]).toEqual({
        name: "search_contacts",
        args: { cTelegram: "tg-42", limit: 5 },
      });
      expect(JSON.parse(result)).toEqual({ ok: true });
    });
  });

  it("lookupContactByTelegram returns error JSON when telegram id unset", async () => {
    const result = await lookupContactByTelegram(callTool);
    expect(JSON.parse(result)).toMatchObject({
      error: expect.stringContaining("Telegram user id is not set"),
    });
  });

  it("normalizeContactLookupResult keeps found contacts and missingFields", () => {
    const raw = JSON.stringify({
      success: true,
      contacts: [
        {
          id: "c-1",
          firstName: "Ada",
          lastName: null,
          phoneNumber: "123",
          missingFields: ["lastName"],
        },
      ],
    });
    expect(normalizeContactLookupResult(raw)).toEqual({
      contacts: [
        {
          id: "c-1",
          firstName: "Ada",
          lastName: null,
          phoneNumber: "123",
          missingFields: ["lastName"],
        },
      ],
    });
  });

  it("normalizeContactLookupResult maps list key and empty contacts", () => {
    expect(normalizeContactLookupResult(JSON.stringify({ list: [{ id: "c-2" }] }))).toEqual({
      contacts: [{ id: "c-2" }],
    });
    expect(normalizeContactLookupResult(JSON.stringify({ contacts: [] }))).toEqual({
      contacts: [],
    });
  });

  it("normalizeContactLookupResult maps error JSON", () => {
    expect(normalizeContactLookupResult(JSON.stringify({ error: "CRM down" }))).toEqual({
      contacts: [],
      error: "CRM down",
    });
    expect(normalizeContactLookupResult("not-json")).toEqual({
      contacts: [],
      error: "Invalid contact lookup JSON",
    });
  });

  it("extractContactIdFromSearchResult reads the first contact id", () => {
    expect(
      extractContactIdFromSearchResult(
        JSON.stringify({ success: true, contacts: [{ id: "c-1", firstName: "Ada" }] }),
      ),
    ).toBe("c-1");
    expect(
      extractContactIdFromSearchResult(JSON.stringify({ list: [{ id: "c-2" }] })),
    ).toBe("c-2");
    expect(extractContactIdFromSearchResult(JSON.stringify({ error: "down" }))).toBeNull();
    expect(extractContactIdFromSearchResult(JSON.stringify({ contacts: [] }))).toBeNull();
    expect(extractContactIdFromSearchResult("not-json")).toBeNull();
  });

  it("throws when telegram user id is unset", async () => {
    const result = await lookupContactByTelegram(callTool);
    expect(JSON.parse(result)).toMatchObject({
      error: expect.stringContaining("Telegram user id is not set"),
    });
  });
});
