import { describe, expect, it, vi } from "vitest";

import { prepareIdentityKnownContact } from "../scenarios/identity.js";
import { writeTelegramId } from "../env.js";
import type { CleanupRegistryLike, SmokeEnv } from "../types.js";

const baseEnv = (overrides: Partial<SmokeEnv> = {}): SmokeEnv => ({
  telegramIdA: writeTelegramId("1"),
  allowWrites: false,
  allowRemoteCrm: false,
  nodeEnv: "development",
  ...overrides,
});

const emptyCleanup = (): CleanupRegistryLike & { contactIds: string[] } => {
  const contactIds: string[] = [];
  return {
    contactIds,
    trackMeeting: () => {},
    trackContact: (id) => {
      contactIds.push(id);
    },
    run: async () => {},
  };
};

describe("prepareIdentityKnownContact", () => {
  it("does not track a pre-existing 9998 contact for cleanup", async () => {
    const knownId = writeTelegramId("1");
    const callTool = vi.fn(async (name: string) => {
      if (name === "search_contacts" || name === "search_entity") {
        return { list: [{ id: "pre-existing-c1", cTelegram: knownId }] };
      }
      throw new Error(`unexpected tool ${name}`);
    });
    const cleanup = emptyCleanup();

    await prepareIdentityKnownContact({
      callTool: callTool as never,
      cleanup,
      knownId,
      env: baseEnv({ knownTelegramId: knownId }),
      writesAllowed: true,
    });

    expect(cleanup.contactIds).toEqual([]);
    expect(callTool).not.toHaveBeenCalledWith(
      "create_contact",
      expect.anything(),
    );
  });

  it("refuses to create when SMOKE_KNOWN_TELEGRAM_ID is set and missing", async () => {
    const knownId = "1363967211";
    const callTool = vi.fn(async () => ({ list: [] }));
    const cleanup = emptyCleanup();

    await expect(
      prepareIdentityKnownContact({
        callTool: callTool as never,
        cleanup,
        knownId,
        env: baseEnv({ knownTelegramId: knownId }),
        writesAllowed: true,
      }),
    ).rejects.toThrow(/read-only|no Contact/);

    expect(cleanup.contactIds).toEqual([]);
  });

  it("seeds and tracks only when the id was generated and writes are allowed", async () => {
    const knownId = writeTelegramId("1");
    const callTool = vi.fn(async (name: string) => {
      if (name === "search_contacts" || name === "search_entity") {
        return { list: [] };
      }
      if (name === "create_contact") {
        return { id: "created-c1" };
      }
      throw new Error(`unexpected tool ${name}`);
    });
    const cleanup = emptyCleanup();

    await prepareIdentityKnownContact({
      callTool: callTool as never,
      cleanup,
      knownId,
      env: baseEnv({ knownTelegramId: undefined, telegramIdA: knownId }),
      writesAllowed: true,
    });

    expect(cleanup.contactIds).toEqual(["created-c1"]);
  });
});
