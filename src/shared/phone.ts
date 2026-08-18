import { parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod";

import type { McpCallTool } from "./mcp.js";

const DEFAULT_REGION = "UA" as const;
const PHONE_PARSE_ERROR = "Could not parse phone number";

/** E.164 (`+380…`, `+48…`, …) or null when the number is not a valid dialable number. */
export const normalizeClinicPhone = (raw: string): string | null => {
  const parsed = parsePhoneNumberFromString(raw.trim(), DEFAULT_REGION);
  if (!parsed?.isValid()) {
    return null;
  }
  return parsed.format("E.164");
};

const toE164 = (raw: string, ctx: z.RefinementCtx): string => {
  const phone = normalizeClinicPhone(raw);
  if (!phone) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: PHONE_PARSE_ERROR,
    });
    return z.NEVER;
  }
  return phone;
};

/** Required phone: local UA or +international → E.164, else Zod error. */
export const clinicPhoneSchema = z.string().transform(toE164);

/** Omitted or blank → undefined; otherwise same as `clinicPhoneSchema`. */
export const optionalClinicPhoneSchema = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw.trim() === "") {
      return undefined;
    }
    return toE164(raw, ctx);
  });

const PHONE_PARSE_ERROR_RESULT = { ok: false as const, error: PHONE_PARSE_ERROR };

const rewritePhoneField = (
  record: Record<string, unknown>,
  key: "phoneNumber",
): { ok: true; record: Record<string, unknown> } | { ok: false; error: string } => {
  if (!(key in record)) {
    return { ok: true, record };
  }
  const raw = record[key];
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    const { [key]: _omitted, ...rest } = record;
    return { ok: true, record: rest };
  }
  if (typeof raw !== "string") {
    return PHONE_PARSE_ERROR_RESULT;
  }
  const e164 = normalizeClinicPhone(raw);
  if (!e164) {
    return PHONE_PARSE_ERROR_RESULT;
  }
  return { ok: true, record: { ...record, [key]: e164 } };
};

/** Rewrite top-level and `data.phoneNumber` to E.164 before MCP. */
export const applyClinicPhoneToMcpArgs = (
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } => {
  const top = rewritePhoneField(args, "phoneNumber");
  if (!top.ok) {
    return top;
  }
  const data = top.record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: true, args: top.record };
  }
  const nested = rewritePhoneField(data as Record<string, unknown>, "phoneNumber");
  if (!nested.ok) {
    return nested;
  }
  return { ok: true, args: { ...top.record, data: nested.record } };
};

/** MCP wrapper: never send a local/unparsed phoneNumber to EspoCRM. */
export const withNormalizedClinicPhones = (callTool: McpCallTool): McpCallTool =>
  async (name, args) => {
    const prepared = applyClinicPhoneToMcpArgs(args);
    if (!prepared.ok) {
      throw new Error(prepared.error);
    }
    return callTool(name, prepared.args);
  };
