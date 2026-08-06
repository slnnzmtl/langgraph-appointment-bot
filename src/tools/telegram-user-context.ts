/**
 * Process-local Telegram user id for identity-enforcing CRM tools.
 * Phase 4 adapter sets this per turn from ctx.from.id; Phase 2 tests set it explicitly.
 * Never trust LLM-supplied telegram ids for cTelegram writes.
 */
let telegramUserId: string | undefined;

export const setTelegramUserId = (id: string | undefined): void => {
  telegramUserId = id;
};

export const getTelegramUserId = (): string => {
  if (!telegramUserId) {
    throw new Error(
      "Telegram user id is not set for this turn. The adapter must call setTelegramUserId before invoke.",
    );
  }
  return telegramUserId;
};

export const clearTelegramUserId = (): void => {
  telegramUserId = undefined;
};
