import { describe, expect, it, beforeEach } from "vitest";

import { createContactTools, lookupContactByTelegram } from "../contact-tools.js";
import { runWithTelegramUserId } from "../telegram-user-context.js";

type CallRecord = { name: string; args: Record<string, unknown> };

const withTg = <T>(fn: () => Promise<T> | T): Promise<T> | T =>
  runWithTelegramUserId("tg-42", fn);

describe("contact-tools", () => {
  const calls: CallRecord[] = [];

  beforeEach(() => {
    calls.length = 0;
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

  it("find_contact_by_telegram uses holder id", async () => {
    await withTg(async () => {
      const [find] = createContactTools({ callTool }).filter(
        (tool) => tool.name === "find_contact_by_telegram",
      );

      expect(find).toBeDefined();
      await find!.invoke({});

      expect(calls[0]).toEqual({
        name: "search_contacts",
        args: { cTelegram: "tg-42", limit: 5 },
      });
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

  it("throws when telegram user id is unset", async () => {
    const [find] = createContactTools({ callTool }).filter(
      (tool) => tool.name === "find_contact_by_telegram",
    );

    const result = await find!.invoke({});
    expect(JSON.parse(result as string)).toMatchObject({
      error: expect.stringContaining("Telegram user id is not set"),
    });
  });
});
