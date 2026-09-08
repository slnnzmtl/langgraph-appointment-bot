import { afterEach, describe, expect, it, vi } from "vitest";

const CLINIC_ENV_KEYS = [
  "CLINIC_ADDRESS",
  "CLINIC_MAPS_URL",
  "CONSULTATION_SERVICE_ID",
  "CLINIC_NAME_UK",
  "CLINIC_NAME_EN",
  "CLINIC_WELCOME_VENUE_UK",
  "CLINIC_DOCTOR_REF_UK",
] as const;

const DEMO = {
  CLINIC_ADDRESS: "вул. Прикладна 1, м. Київ",
  CLINIC_MAPS_URL: "https://www.google.com/maps?q=Kyiv,+Ukraine",
  CONSULTATION_SERVICE_ID: "demo-consultation-service-id",
  CLINIC_NAME_UK: "демонстраційна клініка косметичної медицини",
  CLINIC_NAME_EN: "a demo cosmetic medicine clinic",
  CLINIC_WELCOME_VENUE_UK: "демонстраційного косметологічного кабінету",
  CLINIC_DOCTOR_REF_UK: "лікаря",
} as const;

describe("clinic-constants env overlay", () => {
  const previous = Object.fromEntries(CLINIC_ENV_KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of CLINIC_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.resetModules();
  });

  const clearClinicEnv = (): void => {
    for (const key of CLINIC_ENV_KEYS) {
      delete process.env[key];
    }
  };

  it("uses demo placeholders when clinic env vars are unset", async () => {
    clearClinicEnv();
    vi.resetModules();
    const constants = await import("../clinic-constants.js");
    expect(constants.CLINIC_ADDRESS).toBe(DEMO.CLINIC_ADDRESS);
    expect(constants.CLINIC_MAPS_URL).toBe(DEMO.CLINIC_MAPS_URL);
    expect(constants.CLINIC_MAPS_MARKDOWN).toBe(`[Google maps](${DEMO.CLINIC_MAPS_URL})`);
    expect(constants.CONSULTATION_SERVICE_ID).toBe(DEMO.CONSULTATION_SERVICE_ID);
    expect(constants.CLINIC_NAME_UK).toBe(DEMO.CLINIC_NAME_UK);
    expect(constants.CLINIC_NAME_EN).toBe(DEMO.CLINIC_NAME_EN);
    expect(constants.CLINIC_WELCOME_VENUE_UK).toBe(DEMO.CLINIC_WELCOME_VENUE_UK);
    expect(constants.CLINIC_DOCTOR_REF_UK).toBe(DEMO.CLINIC_DOCTOR_REF_UK);
    expect(constants.PRODUCTION_CLINIC_ENV_KEYS).toEqual([...CLINIC_ENV_KEYS]);
  });

  it("reads clinic branding from env when set", async () => {
    process.env.CLINIC_ADDRESS = "  Test Street 1  ";
    process.env.CLINIC_MAPS_URL = "https://maps.example/test";
    process.env.CONSULTATION_SERVICE_ID = "crm-service-123";
    process.env.CLINIC_NAME_UK = "тестова клініка";
    process.env.CLINIC_NAME_EN = "Test Clinic";
    process.env.CLINIC_WELCOME_VENUE_UK = "тестового кабінету";
    process.env.CLINIC_DOCTOR_REF_UK = "лікаря Теста";
    vi.resetModules();
    const constants = await import("../clinic-constants.js");
    expect(constants.CLINIC_ADDRESS).toBe("Test Street 1");
    expect(constants.CLINIC_MAPS_URL).toBe("https://maps.example/test");
    expect(constants.CLINIC_MAPS_MARKDOWN).toBe("[Google maps](https://maps.example/test)");
    expect(constants.CONSULTATION_SERVICE_ID).toBe("crm-service-123");
    expect(constants.CLINIC_NAME_UK).toBe("тестова клініка");
    expect(constants.CLINIC_NAME_EN).toBe("Test Clinic");
    expect(constants.CLINIC_WELCOME_VENUE_UK).toBe("тестового кабінету");
    expect(constants.CLINIC_DOCTOR_REF_UK).toBe("лікаря Теста");
  });
});
