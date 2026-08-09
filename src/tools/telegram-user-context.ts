import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-async-context Telegram user id for identity-enforcing CRM tools.
 * Adapter / smoke wrap each turn with runWithTelegramUserId(from.id).
 * Never trust LLM-supplied telegram ids for cTelegram writes.
 */
const telegramUserIdStore = new AsyncLocalStorage<string>();

export const runWithTelegramUserId = <T>(
  id: string,
  fn: () => T,
): T => telegramUserIdStore.run(id, fn);

export const getTelegramUserId = (): string => {
  const id = telegramUserIdStore.getStore();
  if (!id) {
    throw new Error(
      "Telegram user id is not set for this turn. The adapter must call runWithTelegramUserId before invoke.",
    );
  }
  return id;
};
