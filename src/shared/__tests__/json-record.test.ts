import { describe, expect, it } from "vitest";

import { asJsonRecord, errorMessage, jsonEntityId, jsonErrorMessage } from "../json-record.js";

describe("asJsonRecord", () => {
  it("parses object JSON and objects", () => {
    expect(asJsonRecord('{"id":"c-1"}')).toEqual({ id: "c-1" });
    expect(asJsonRecord({ id: "c-1" })).toEqual({ id: "c-1" });
  });

  it("returns null for arrays, primitives, and invalid JSON", () => {
    expect(asJsonRecord("[]")).toBeNull();
    expect(asJsonRecord("not-json")).toBeNull();
    expect(asJsonRecord(null)).toBeNull();
  });
});

describe("jsonErrorMessage / jsonEntityId", () => {
  it("reads error and id", () => {
    expect(jsonErrorMessage('{"error":"CRM down"}')).toBe("CRM down");
    expect(jsonEntityId('{"id":"m-1"}')).toBe("m-1");
    expect(jsonEntityId('{"id":""}')).toBeUndefined();
    expect(jsonErrorMessage('{"ok":true}')).toBeUndefined();
  });
});

describe("errorMessage", () => {
  it("unwraps Error and stringifies other values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
  });
});
