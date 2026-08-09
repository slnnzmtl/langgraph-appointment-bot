export const toToolResult = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);
