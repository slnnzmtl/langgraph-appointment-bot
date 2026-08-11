import { describe, expect, it } from "vitest";

import { prefetchBookingContext } from "../compile.js";
import { runWithTelegramUserId } from "../../tools/telegram-user-context.js";

describe("prefetchBookingContext", () => {
  it("chains contact lookup then planned meetings", async () => {
    const names: string[] = [];
    const result = await runWithTelegramUserId("tg-1", () =>
      prefetchBookingContext(async (name, args) => {
        names.push(name);
        if (name === "search_contacts") {
          return { success: true, contacts: [{ id: "c-1", firstName: "Ada" }] };
        }
        expect(name).toBe("search_entity");
        expect(args).toMatchObject({
          entityType: "Meeting",
          filters: { parentId: "c-1", parentType: "Contact", status: "Planned" },
        });
        return {
          list: [
            {
              id: "m-1",
              name: "Consult",
              dateStart: "2026-08-17 11:00:00",
              dateEnd: "2026-08-17 11:30:00",
            },
          ],
        };
      }),
    );

    expect(names).toEqual(["search_contacts", "search_entity"]);
    expect(result.contactContext.contacts).toEqual([
      { id: "c-1", firstName: "Ada", missingFields: ["lastName", "phoneNumber"] },
    ]);
    expect(result.bookingContext?.meetings).toEqual([
      {
        id: "m-1",
        name: "Consult",
        dateStart: "2026-08-17 11:00:00",
        dateEnd: "2026-08-17 11:30:00",
      },
    ]);
  });

  it("sets contactContext when no contact id and skips meetings lookup", async () => {
    const names: string[] = [];
    const result = await runWithTelegramUserId("tg-1", () =>
      prefetchBookingContext(async (name) => {
        names.push(name);
        return { success: true, contacts: [] };
      }),
    );
    expect(names).toEqual(["search_contacts"]);
    expect(result.contactContext).toEqual({ contacts: [] });
    expect(result.bookingContext).toBeNull();
  });

  it("keeps contactContext when meetings lookup fails", async () => {
    const result = await runWithTelegramUserId("tg-1", () =>
      prefetchBookingContext(async (name) => {
        if (name === "search_contacts") {
          return { success: true, contacts: [{ id: "c-1" }] };
        }
        throw new Error("CRM down");
      }),
    );
    expect(result.contactContext.contacts).toEqual([
      { id: "c-1", missingFields: ["firstName", "lastName", "phoneNumber"] },
    ]);
    expect(result.bookingContext).toBeNull();
  });
});
