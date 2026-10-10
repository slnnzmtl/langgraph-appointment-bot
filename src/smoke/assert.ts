import type { CallRecord, SoftWarning } from "./types.js";

export class SmokeAssertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeAssertError";
  }
}

export const soft = (
  warnings: SoftWarning[],
  label: string,
  ok: boolean,
  detail?: string,
): void => {
  if (ok) {
    return;
  }
  warnings.push({ label, ...(detail ? { detail } : {}) });
  const suffix = detail ? `: ${detail}` : "";
  console.warn(`⚠ Soft: ${label}${suffix}`);
};

export const expectCalled = (
  label: string,
  calls: CallRecord[],
  toolName: string,
): CallRecord[] => {
  const matched = calls.filter((call) => call.name === toolName);
  if (matched.length === 0) {
    throw new SmokeAssertError(
      `${label}: expected MCP call ${toolName}, got [${calls.map((c) => c.name).join(",") || "none"}]`,
    );
  }
  return matched;
};

export const expectNotCalled = (
  label: string,
  calls: CallRecord[],
  toolNames: string | string[],
): void => {
  const names = Array.isArray(toolNames) ? toolNames : [toolNames];
  for (const toolName of names) {
    if (calls.some((call) => call.name === toolName)) {
      throw new SmokeAssertError(
        `${label}: must not call ${toolName} (calls=${calls.map((c) => c.name).join(",")})`,
      );
    }
  }
};

export const expectInteraction = (
  label: string,
  kind: string | undefined | null,
  expected: string,
): void => {
  if (kind !== expected) {
    throw new SmokeAssertError(
      `${label}: expected pendingInteraction.kind=${expected}, got ${kind ?? "null"}`,
    );
  }
};

export const expectButtons = (
  label: string,
  buttons: string[],
  required: string[],
): void => {
  for (const requiredLabel of required) {
    if (!buttons.includes(requiredLabel)) {
      throw new SmokeAssertError(
        `${label}: expected button "${requiredLabel}", got [${buttons.join(" | ") || "none"}]`,
      );
    }
  }
};

export const expectNoButtons = (
  label: string,
  buttons: string[],
  forbidden: string[],
): void => {
  for (const forbiddenLabel of forbidden) {
    if (buttons.includes(forbiddenLabel)) {
      throw new SmokeAssertError(
        `${label}: unexpected button "${forbiddenLabel}" on [${buttons.join(" | ")}]`,
      );
    }
  }
};

export const expectEquals = <T>(
  label: string,
  actual: T,
  expected: T,
): void => {
  if (actual !== expected) {
    throw new SmokeAssertError(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
};

export const expectTruthy = (label: string, value: unknown): void => {
  if (!value) {
    throw new SmokeAssertError(`${label}: expected truthy value`);
  }
};
