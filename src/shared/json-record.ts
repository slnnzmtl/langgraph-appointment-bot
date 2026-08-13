/** Parse a JSON object from a string or already-parsed value. Arrays and primitives → null. */
export const asJsonRecord = (raw: unknown): Record<string, unknown> | null => {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

export const jsonErrorMessage = (raw: unknown): string | undefined => {
  const error = asJsonRecord(raw)?.error;
  return typeof error === "string" ? error : undefined;
};

export const jsonEntityId = (raw: unknown): string | undefined => {
  const id = asJsonRecord(raw)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
