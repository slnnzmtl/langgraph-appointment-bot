import {
  CLINIC_ADDRESS,
  DEFAULT_MENU_HAS_VISITS,
  DEFAULT_MENU_NO_VISITS,
  MAIN_MENU_LABEL,
} from "../../shared/clinic-constants.js";
import { expectButtons, soft } from "../assert.js";
import { findContactByTelegram, listPlannedMeetingIds } from "../crm.js";
import { createSmokeSession, installCallToolRecorder } from "../harness.js";
import type { SoftWarning, SmokeScenario } from "../types.js";

export const supervisorMenuScenario: SmokeScenario = {
  name: "supervisor-menu",
  tier: "invoke",
  run: async (ctx) => {
    const warnings: SoftWarning[] = [];
    const recorder = installCallToolRecorder(ctx.runtime.getBootstrap().adapters, ctx.cleanup);
    try {
      const session = createSmokeSession(ctx.runtime, {
        telegramId: ctx.env.telegramIdA,
        scenario: "supervisor-menu",
        recorder,
        cleanup: ctx.cleanup,
      });

      let hasVisit = false;
      const contact = await findContactByTelegram(ctx.callTool, ctx.env.telegramIdA);
      if (contact) {
        const meetings = await listPlannedMeetingIds(ctx.callTool, contact.id);
        hasVisit = meetings.length > 0;
      }
      const expectedMenu = hasVisit ? DEFAULT_MENU_HAS_VISITS : DEFAULT_MENU_NO_VISITS;

      const hello = await session.say("Привіт");
      expectButtons("supervisor-menu hello", hello.buttons, [
        ...expectedMenu,
        MAIN_MENU_LABEL,
      ]);
      console.log("✓ supervisor-menu: DEFAULT MENU after Привіт");

      const address = await session.say("Адреса");
      soft(
        warnings,
        "address reply includes CLINIC_ADDRESS",
        address.reply.includes(CLINIC_ADDRESS),
        address.reply.slice(0, 200),
      );
      console.log("✓ supervisor-menu: Адреса turn completed");
      return { warnings, turns: session.turns };
    } finally {
      recorder.restore();
    }
  },
};
