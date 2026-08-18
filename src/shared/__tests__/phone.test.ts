import { describe, expect, it } from "vitest";

import { clinicPhoneSchema, normalizeClinicPhone, optionalClinicPhoneSchema, applyClinicPhoneToMcpArgs } from "../phone.js";

describe("normalizeClinicPhone", () => {
  it("maps local UA (screenshot) to E.164", () => {
    expect(normalizeClinicPhone("0581231231")).toBe("+380581231231");
    expect(normalizeClinicPhone("0505929383")).toBe("+380505929383");
    expect(normalizeClinicPhone("0501838282")).toBe("+380501838282");
  });

  it("keeps already-international UA and punctuation", () => {
    expect(normalizeClinicPhone("+380501112233")).toBe("+380501112233");
    expect(normalizeClinicPhone("+380501838282")).toBe("+380501838282");
    expect(normalizeClinicPhone("050 111 22 33")).toBe("+380501112233");
  });

  it("maps foreign + and 00 prefixes to E.164", () => {
    expect(normalizeClinicPhone("+48 512 345 678")).toBe("+48512345678");
    expect(normalizeClinicPhone("0048501234567")).toBe("+48501234567");
  });

  it("returns null for garbage and too-short input", () => {
    expect(normalizeClinicPhone("garbage")).toBeNull();
    expect(normalizeClinicPhone("123")).toBeNull();
  });

  it("rejects malformed UA numbers that are possible but not valid", () => {
    // Trunk 0 kept after the country code (Espo rejects these with 500).
    expect(normalizeClinicPhone("+380050183828")).toBeNull();
    expect(normalizeClinicPhone("380050183828")).toBeNull();
  });
});

describe("clinicPhoneSchema", () => {
  it("normalizes required and optional phones to E.164", () => {
    expect(clinicPhoneSchema.parse("0505929383")).toBe("+380505929383");
    expect(optionalClinicPhoneSchema.parse("0581231231")).toBe("+380581231231");
    expect(optionalClinicPhoneSchema.parse(undefined)).toBeUndefined();
    expect(optionalClinicPhoneSchema.parse("")).toBeUndefined();
    expect(optionalClinicPhoneSchema.parse("   ")).toBeUndefined();
  });

  it("fails with a parse error for garbage", () => {
    expect(() => clinicPhoneSchema.parse("garbage")).toThrow(/Could not parse phone number/);
    expect(() => optionalClinicPhoneSchema.parse("123")).toThrow(/Could not parse phone number/);
  });
});

describe("applyClinicPhoneToMcpArgs", () => {
  it("rewrites top-level and nested data.phoneNumber to E.164", () => {
    expect(applyClinicPhoneToMcpArgs({ phoneNumber: "0501838282" })).toEqual({
      ok: true,
      args: { phoneNumber: "+380501838282" },
    });
    expect(
      applyClinicPhoneToMcpArgs({
        entityType: "Contact",
        data: { firstName: "Ada", phoneNumber: "0501838282" },
      }),
    ).toEqual({
      ok: true,
      args: {
        entityType: "Contact",
        data: { firstName: "Ada", phoneNumber: "+380501838282" },
      },
    });
  });

  it("rejects garbage and omits blank phones", () => {
    expect(applyClinicPhoneToMcpArgs({ phoneNumber: "garbage" })).toEqual({
      ok: false,
      error: "Could not parse phone number",
    });
    expect(applyClinicPhoneToMcpArgs({ phoneNumber: "+380050183828" })).toEqual({
      ok: false,
      error: "Could not parse phone number",
    });
    expect(applyClinicPhoneToMcpArgs({ firstName: "Ada", phoneNumber: "  " })).toEqual({
      ok: true,
      args: { firstName: "Ada" },
    });
  });
});
