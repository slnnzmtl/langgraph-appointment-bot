export const DEFAULT_MESSAGE_HISTORY_MAX_TOKENS = 6_000;

export const getMessageHistoryMaxTokens = (): number => {
  const raw = process.env.MESSAGE_HISTORY_MAX_TOKENS;
  if (!raw) {
    return DEFAULT_MESSAGE_HISTORY_MAX_TOKENS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MESSAGE_HISTORY_MAX_TOKENS;
};
