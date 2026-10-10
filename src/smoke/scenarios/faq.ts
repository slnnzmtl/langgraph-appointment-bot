import {
  BOOKING_OFFER_MENU,
  RETURN_TO_BOOKING_LABEL_UK,
  SERVICE_CANDIDATE_OTHER_LABEL_UK,
} from "../../shared/clinic-constants.js";
import {
  expectButtons,
  expectCalled,
  expectInteraction,
  expectNotCalled,
  SmokeAssertError,
  soft,
} from "../assert.js";
import {
  createSmokeSession,
  installCallToolRecorder,
  type SmokeSession,
  type TurnResult,
} from "../harness.js";
import type { SoftWarning, SmokeScenario } from "../types.js";
import {
  drillToProcedureOffer,
  openBookingOffer,
} from "./offer-helpers.js";

const WRITE_TOOLS = [
  "create_meeting",
  "update_meeting",
  "create_contact",
  "cancel_meeting",
  "reschedule_meeting",
] as const;

const PRICE_HINT = /грн|\d/i;

const hasBookingOfferKeyboard = (buttons: string[]): boolean =>
  buttons.includes(BOOKING_OFFER_MENU[0]) && buttons.includes(BOOKING_OFFER_MENU[1]);

/**
 * Page catalog until «Повернутися до запису» is tappable, then tap it.
 * FAQ may already have re-offered (Так / Обрати іншу) on the previous turn.
 */
const returnToBookingOffer = async (
  session: SmokeSession,
  label: string,
  maxTurns = 6,
): Promise<TurnResult> => {
  for (let i = 0; i < maxTurns; i += 1) {
    const snap = await session.snapshot();
    if (hasBookingOfferKeyboard(snap.buttons)) {
      return snap;
    }
    if (snap.buttons.includes(RETURN_TO_BOOKING_LABEL_UK)) {
      return session.tap(RETURN_TO_BOOKING_LABEL_UK);
    }
    if (snap.buttons.includes(SERVICE_CANDIDATE_OTHER_LABEL_UK)) {
      await session.tap(SERVICE_CANDIDATE_OTHER_LABEL_UK);
      continue;
    }
    const interaction = snap.state.pendingInteraction;
    if (interaction?.kind === "service_candidate") {
      const next = interaction.choices.find(
        (choice) =>
          choice.id !== "other"
          && choice.id !== "return_to_booking"
          && snap.buttons.includes(choice.label),
      );
      if (next) {
        await session.tap(next.label);
        continue;
      }
    }
    break;
  }
  const final = await session.snapshot();
  throw new SmokeAssertError(
    `${label}: never saw ${RETURN_TO_BOOKING_LABEL_UK} (buttons=[${final.buttons.join(" | ") || "none"}])`,
  );
};

const withSession = async (
  ctx: Parameters<SmokeScenario["run"]>[0],
  scenario: string,
  telegramId: string,
  body: (session: ReturnType<typeof createSmokeSession>, warnings: SoftWarning[]) => Promise<void>,
): Promise<{ warnings: SoftWarning[]; turns: number }> => {
  const warnings: SoftWarning[] = [];
  const recorder = installCallToolRecorder(ctx.runtime.getBootstrap().adapters, ctx.cleanup);
  try {
    const session = createSmokeSession(ctx.runtime, {
      telegramId,
      scenario,
      recorder,
      cleanup: ctx.cleanup,
    });
    await body(session, warnings);
    return { warnings, turns: session.turns };
  } finally {
    recorder.restore();
  }
};

/** Recorder sees MCP names: list_services → search_entity(cService), get_service → get_entity(cService). */
const isCServiceSearch = (call: { name: string; args: Record<string, unknown> }): boolean =>
  call.name === "search_entity" && call.args.entityType === "cService";

const isCServiceGet = (call: { name: string; args: Record<string, unknown> }): boolean =>
  call.name === "get_entity" && call.args.entityType === "cService";

export const faqHoursScenario: SmokeScenario = {
  name: "faq-hours",
  tier: "invoke",
  run: async (ctx) =>
    withSession(ctx, "faq-hours", ctx.env.telegramIdA, async (session, warnings) => {
      const turn = await session.say("Які у вас години роботи?");
      const working = expectCalled("faq-hours", turn.calls, "get_working_time");
      for (const call of working) {
        if (call.error) {
          soft(warnings, "faq-hours get_working_time returned error", false, call.error);
          continue;
        }
        // MCP may return HTTP 200 with `{ error: "…" }` when the assigned user has no calendar.
        const body =
          typeof call.result === "string"
            ? (() => {
                try {
                  return JSON.parse(call.result) as { error?: unknown };
                } catch {
                  return null;
                }
              })()
            : call.result && typeof call.result === "object"
              ? (call.result as { error?: unknown })
              : null;
        if (typeof body?.error === "string" && body.error.trim()) {
          soft(warnings, "faq-hours get_working_time returned error", false, body.error);
        }
      }
      expectNotCalled("faq-hours", turn.calls, [...WRITE_TOOLS]);
      console.log("✓ faq-hours: get_working_time, no writes");
      console.log("  reply:", turn.reply.slice(0, 200));
    }),
};

export const faqCatalogScenario: SmokeScenario = {
  name: "faq-catalog",
  tier: "invoke",
  run: async (ctx) =>
    withSession(ctx, "faq-catalog", ctx.env.telegramIdA, async (session, warnings) => {
      const turn = await session.say("Послуги");
      const listed = turn.calls.filter(isCServiceSearch);
      if (listed.length === 0) {
        throw new Error(
          `faq-catalog: expected MCP search_entity(cService) for list_services, got [${turn.calls.map((c) => c.name).join(",") || "none"}]`,
        );
      }
      expectNotCalled("faq-catalog", turn.calls, [...WRITE_TOOLS]);

      const interaction = turn.state.pendingInteraction;
      if (interaction?.kind === "service_candidate") {
        expectInteraction("faq-catalog", interaction.kind, "service_candidate");
        if (interaction.owner !== "faq") {
          throw new Error(
            `faq-catalog: expected service_candidate.owner=faq, got ${interaction.owner ?? "undefined"}`,
          );
        }
        const choiceLabels = interaction.choices.map((choice) => choice.label);
        for (const label of choiceLabels) {
          if (!turn.buttons.includes(label) && label !== "Головне меню") {
            soft(
              warnings,
              "faq-catalog button missing for choice",
              false,
              label,
            );
          }
        }
        const first = interaction.choices.find(
          (choice) => choice.id !== "other" && choice.label !== "Інші варіанти",
        );
        if (first && turn.buttons.includes(first.label)) {
          const drill = await session.tap(first.label);
          const next = drill.state.pendingInteraction;
          if (
            next
            && !(
              (next.kind === "service_candidate" && next.owner === "faq")
              || next.kind === "service_confirm"
            )
          ) {
            throw new Error(
              `faq-catalog: after tap expected FAQ catalog/confirm, got ${next.kind}`,
            );
          }
          console.log("✓ faq-catalog: list_services + FAQ drill-down");
        } else {
          console.log("✓ faq-catalog: list_services + service_candidate opened");
        }
      } else {
        // LLM may answer with text + consultation offer without opening catalog chips.
        soft(
          warnings,
          "faq-catalog did not open service_candidate (text reply only)",
          false,
          turn.state.pendingInteraction?.kind ?? "null",
        );
        console.log("✓ faq-catalog: list_services called");
      }
    }),
};

export const faqPriceScenario: SmokeScenario = {
  name: "faq-price",
  tier: "invoke",
  run: async (ctx) =>
    withSession(ctx, "faq-price", ctx.env.telegramIdA, async (session, warnings) => {
      const turn = await session.say("Скільки коштує консультація?");
      const getService = turn.calls.filter(isCServiceGet);
      if (getService.length === 0) {
        // Some runs call list_services then get_service on a follow-up; allow list+soft.
        const listed = turn.calls.some(isCServiceSearch);
        if (!listed) {
          throw new Error(
            `faq-price: expected MCP get_entity(cService) or search_entity(cService), got [${turn.calls.map((c) => c.name).join(",") || "none"}]`,
          );
        }
        soft(warnings, "faq-price used list_services without get_service this turn", false);
      } else {
        console.log("✓ faq-price: get_service called");
      }
      expectNotCalled("faq-price", turn.calls, [...WRITE_TOOLS]);
      console.log("  reply:", turn.reply.slice(0, 200));
    }),
};

export const faqChooseOtherScenario: SmokeScenario = {
  name: "faq-choose-other",
  tier: "invoke",
  run: async (ctx) =>
    withSession(ctx, "faq-choose-other", ctx.env.telegramIdA, async (session, warnings) => {
      await openBookingOffer(session, "faq-choose-other");
      const catalog = await session.tap(BOOKING_OFFER_MENU[1]);

      const interaction = catalog.state.pendingInteraction;
      expectInteraction("faq-choose-other", interaction?.kind, "service_candidate");
      if (interaction?.kind === "service_candidate" && interaction.owner !== "faq") {
        throw new SmokeAssertError(
          `faq-choose-other: expected service_candidate.owner=faq, got ${interaction.owner ?? "undefined"}`,
        );
      }
      if (!catalog.calls.some(isCServiceSearch)) {
        throw new SmokeAssertError(
          `faq-choose-other: expected search_entity(cService), got [${catalog.calls.map((c) => c.name).join(",") || "none"}]`,
        );
      }
      expectNotCalled("faq-choose-other catalog", catalog.calls, [...WRITE_TOOLS]);

      const compare = await session.say("Порівняй ціни цих варіантів");
      expectNotCalled("faq-choose-other compare", compare.calls, [...WRITE_TOOLS]);
      soft(
        warnings,
        "faq-choose-other compare used no cService MCP",
        compare.calls.some(isCServiceSearch) || compare.calls.some(isCServiceGet),
      );

      const returned = await returnToBookingOffer(session, "faq-choose-other");
      expectButtons("faq-choose-other return", returned.buttons, [...BOOKING_OFFER_MENU]);
      console.log("✓ faq-choose-other: catalog → compare → return to BOOKING OFFER");
    }),
};

export const offerPriceScenario: SmokeScenario = {
  name: "offer-price",
  tier: "invoke",
  run: async (ctx) =>
    withSession(ctx, "offer-price", ctx.env.telegramIdA, async (session, warnings) => {
      await openBookingOffer(session, "offer-price");
      const offer = await drillToProcedureOffer(session, "offer-price");
      expectInteraction("offer-price", offer.state.pendingInteraction?.kind, "service_confirm");

      const price = await session.say("Скільки коштує?");
      expectButtons("offer-price after price", price.buttons, [...BOOKING_OFFER_MENU]);
      if (!price.calls.some(isCServiceGet) && !price.calls.some(isCServiceSearch)) {
        throw new SmokeAssertError(
          `offer-price: expected get_entity/search_entity(cService), got [${price.calls.map((c) => c.name).join(",") || "none"}]`,
        );
      }
      expectNotCalled("offer-price", price.calls, [...WRITE_TOOLS]);
      soft(
        warnings,
        "offer-price reply missing price-like text",
        PRICE_HINT.test(price.reply),
        price.reply.slice(0, 200),
      );

      const accepted = await session.tap(BOOKING_OFFER_MENU[0]);
      const nextKind = accepted.state.pendingInteraction?.kind;
      if (nextKind !== "date_select" && nextKind !== "time_select") {
        throw new SmokeAssertError(
          `offer-price: after Так expected date_select/time_select, got ${nextKind ?? "null"}`,
        );
      }
      console.log("✓ offer-price: procedure offer → Скільки коштує → Так advances to slots");
    }),
};
