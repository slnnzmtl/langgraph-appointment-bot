/**
 * Configured-model evaluation for the booking note-turn classifier.
 *
 * Usage:
 *   GOOGLE_API_KEY=... pnpm eval:booking-note
 *
 * Writes a markdown report under analysis/. Does not run during `pnpm test`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GeminiConnector } from "@personal-assistant/llm-gemini";

import { createNoteTurnClassifier } from "../graph/booking-note-classifier.js";
import type { NoteTurnKind } from "../graph/booking-note-turn.js";

const FIXTURES: Array<{
  id: string;
  patientText: string;
  currentServiceName: string;
  expectKind: NoteTurnKind;
}> = [
  {
    id: "ua-service-change",
    patientText: "запиши на ботокс",
    currentServiceName: "Консультація",
    expectKind: "service_change_requested",
  },
  {
    id: "ua-explicit-service-change",
    patientText: "запиши мене на ботокс",
    currentServiceName: "Консультація",
    expectKind: "service_change_requested",
  },
  {
    id: "en-mixed-clarification",
    patientText: "I need a consultation regarding Botox",
    currentServiceName: "Botox",
    expectKind: "service_or_note_clarification_required",
  },
  {
    id: "ua-mixed-clarification-juvederm",
    patientText: "потрібна консультація щодо ювідерм",
    currentServiceName: "Juvederm",
    expectKind: "service_or_note_clarification_required",
  },
  {
    id: "ua-mixed-clarification-lips",
    patientText: "потрібна консультація щодо збільшення губ",
    currentServiceName: "Juvederm",
    expectKind: "service_or_note_clarification_required",
  },
  {
    id: "ua-consultation-procedure-wish",
    patientText: "хочу зробити збільшення губ",
    currentServiceName: "Консультація",
    expectKind: "service_or_note_clarification_required",
  },
  {
    id: "ua-genuine-note",
    patientText: "хочу ботокс у зоні лоба",
    currentServiceName: "Консультація",
    expectKind: "note_provided",
  },
  {
    id: "ua-skip-synonym",
    patientText: "ні",
    currentServiceName: "Botox",
    expectKind: "note_skipped",
  },
  {
    id: "en-skip-synonym",
    patientText: "skip",
    currentServiceName: "Botox",
    expectKind: "note_skipped",
  },
];

const main = async (): Promise<void> => {
  const apiKey = process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) {
    console.error("GOOGLE_API_KEY is required for pnpm eval:booking-note");
    process.exit(1);
  }
  const model = process.env.SUPERVISOR_MODEL?.trim() || process.env.GEMINI_MODEL?.trim()
    || "gemini-3.1-flash-lite";
  const classify = createNoteTurnClassifier(new GeminiConnector(apiKey, model));
  const rows: Array<{
    id: string;
    patientText: string;
    expectKind: string;
    gotKind: string;
    query?: string;
    pass: boolean;
  }> = [];

  for (const fixture of FIXTURES) {
    try {
      const result = await classify({
        patientText: fixture.patientText,
        currentServiceName: fixture.currentServiceName,
      });
      rows.push({
        id: fixture.id,
        patientText: fixture.patientText,
        expectKind: fixture.expectKind,
        gotKind: result.kind,
        ...(result.query != null ? { query: result.query } : {}),
        pass: result.kind === fixture.expectKind,
      });
    } catch (error) {
      rows.push({
        id: fixture.id,
        patientText: fixture.patientText,
        expectKind: fixture.expectKind,
        gotKind: `error:${error instanceof Error ? error.message : String(error)}`,
        pass: false,
      });
    }
  }

  const passed = rows.filter((row) => row.pass).length;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = join(dirname(fileURLToPath(import.meta.url)), "../../analysis");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `booking-note-eval-${stamp}.md`);
  const body = [
    `# Booking note classifier eval (${stamp})`,
    "",
    `Model: \`${model}\``,
    `Pass: ${passed}/${rows.length}`,
    "",
    "| id | expect | got | pass | query |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((row) =>
      `| ${row.id} | ${row.expectKind} | ${row.gotKind} | ${row.pass ? "yes" : "no"} | ${row.query ?? ""} |`
    ),
    "",
  ].join("\n");
  writeFileSync(reportPath, body, "utf8");
  console.log(body);
  console.log(`Wrote ${reportPath}`);
  process.exit(passed === rows.length ? 0 : 2);
};

void main();
