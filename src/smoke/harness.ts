import { randomUUID } from "node:crypto";

import {
  handleGraphTextTurn,
  hasPendingConfirmBooking,
} from "../adapter/telegram-bot.js";
import type { ClinicAdapters } from "../composition/clinic-adapters.js";
import type { ClinicRuntime } from "../composition/clinic-runtime.js";
import type { BookingDraft } from "../graph/booking-draft.js";
import type { PendingInteraction } from "../graph/booking-session.js";
import type { ClinicHandoff } from "../graph/types.js";
import type { McpCallTool } from "../shared/mcp.js";
import { SmokeAssertError } from "./assert.js";
import {
  nextAutopilotInput,
  type AutopilotDecision,
  type AutopilotOptions,
} from "./autopilot.js";
import { uniqueSmokePhone } from "./env.js";
import { trackIdsFromCallResult } from "./cleanup.js";
import type { CallRecord, CleanupRegistryLike, SmokeStateSnapshot } from "./types.js";

export type InstallRecorder = {
  calls: CallRecord[];
  drain: () => CallRecord[];
  restore: () => void;
};

/** Wrap adapters.callTool to record each MCP call (and result) for hard asserts. */
export const installCallToolRecorder = (
  adapters: ClinicAdapters,
  cleanup?: CleanupRegistryLike,
): InstallRecorder => {
  const calls: CallRecord[] = [];
  const original = adapters.callTool;
  const wrapped: McpCallTool = async (name, args) => {
    try {
      const result = await original(name, args);
      const record: CallRecord = { name, args, result };
      calls.push(record);
      if (cleanup) {
        trackIdsFromCallResult(cleanup, name, result);
      }
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      calls.push({ name, args, error: message });
      throw error;
    }
  };
  adapters.callTool = wrapped;
  return {
    calls,
    drain: () => {
      const batch = calls.splice(0, calls.length);
      return batch;
    },
    restore: () => {
      adapters.callTool = original;
    },
  };
};

const keyboardLabels = (replyMarkup: unknown): string[] => {
  if (!replyMarkup || typeof replyMarkup !== "object") {
    return [];
  }
  const keyboard = (replyMarkup as { keyboard?: Array<Array<{ text?: string }>> }).keyboard;
  if (!Array.isArray(keyboard)) {
    return [];
  }
  const labels: string[] = [];
  for (const row of keyboard) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const button of row) {
      if (typeof button?.text === "string" && button.text.trim()) {
        labels.push(button.text);
      }
    }
  }
  return labels;
};

const readStateSnapshot = async (
  graph: ReturnType<ClinicRuntime["getGraph"]>,
  threadId: string,
): Promise<{ state: SmokeStateSnapshot; pendingConfirm: boolean }> => {
  const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
  const values = (snapshot.values ?? {}) as {
    pendingInteraction?: PendingInteraction | null;
    bookingDraft?: BookingDraft | null;
    lastHandoff?: ClinicHandoff | null;
    contactContext?: unknown;
    bookingContext?: unknown;
    availabilityContext?: SmokeStateSnapshot["availabilityContext"];
  };
  return {
    state: {
      pendingInteraction: values.pendingInteraction ?? null,
      bookingDraft: values.bookingDraft ?? null,
      lastHandoff: values.lastHandoff ?? null,
      contactContext: values.contactContext ?? null,
      bookingContext: values.bookingContext ?? null,
      availabilityContext: values.availabilityContext ?? null,
    },
    pendingConfirm: hasPendingConfirmBooking(snapshot.tasks),
  };
};

export type TurnResult = {
  reply: string;
  buttons: string[];
  state: SmokeStateSnapshot;
  calls: CallRecord[];
  pendingConfirm: boolean;
};

export type SmokeSession = {
  telegramId: string;
  threadId: string;
  scenario: string;
  turns: number;
  say: (text: string) => Promise<TurnResult>;
  tap: (label: string) => Promise<TurnResult>;
  autopilotBooking: (options: {
    phone: string;
    firstName: string;
    lastName?: string;
    decision: AutopilotDecision;
    maxTurns?: number;
    noteText?: string;
  }) => Promise<{ turns: TurnResult[]; last: TurnResult }>;
  snapshot: () => Promise<TurnResult>;
};

export type CreateSmokeSessionOptions = {
  telegramId: string;
  scenario: string;
  recorder: InstallRecorder;
  cleanup?: CleanupRegistryLike;
};

export const createSmokeSession = (
  runtime: ClinicRuntime,
  options: CreateSmokeSessionOptions,
): SmokeSession => {
  const graph = runtime.getGraph();
  const checkpointer = runtime.getCheckpointer();
  const threadId = `smoke-${options.scenario}-${randomUUID().slice(0, 8)}`;
  const tags = ["smoke", `smoke:${options.scenario}`];
  let turns = 0;
  let lastButtons: string[] = [];

  const say = async (text: string): Promise<TurnResult> => {
    options.recorder.drain();
    const outbound = await handleGraphTextTurn(
      graph,
      threadId,
      options.telegramId,
      text,
      checkpointer,
      { tags, source: "smoke" },
    );
    const calls = options.recorder.drain();
    const { state, pendingConfirm } = await readStateSnapshot(graph, threadId);
    const buttons = keyboardLabels(outbound.reply_markup);
    lastButtons = buttons;
    turns += 1;
    return {
      reply: outbound.text,
      buttons,
      state,
      calls,
      pendingConfirm,
    };
  };

  const tap = async (label: string): Promise<TurnResult> => {
    if (!lastButtons.includes(label)) {
      throw new SmokeAssertError(
        `${options.scenario}: tap "${label}" not on keyboard [${lastButtons.join(" | ") || "none"}]`,
      );
    }
    return say(label);
  };

  const autopilotBooking = async (opts: {
    phone: string;
    firstName: string;
    lastName?: string;
    decision: AutopilotDecision;
    maxTurns?: number;
    noteText?: string;
  }): Promise<{ turns: TurnResult[]; last: TurnResult }> => {
    const maxTurns = opts.maxTurns ?? 12;
    const autopilotOpts: AutopilotOptions = {
      phone: opts.phone,
      firstName: opts.firstName,
      ...(opts.lastName !== undefined ? { lastName: opts.lastName } : {}),
      decision: opts.decision,
      ...(opts.noteText !== undefined ? { noteText: opts.noteText } : {}),
    };
    const collected: TurnResult[] = [];
    let last = await readStateSnapshot(graph, threadId).then(({ state, pendingConfirm }) => ({
      reply: "",
      buttons: lastButtons,
      state,
      calls: [] as CallRecord[],
      pendingConfirm,
    }));

    let lastContactField: string | null = null;
    let sameContactFieldTurns = 0;
    for (let i = 0; i < maxTurns; i += 1) {
      const interaction = last.state.pendingInteraction;
      if (interaction?.kind === "contact_field") {
        if (lastContactField === interaction.field) {
          sameContactFieldTurns += 1;
        } else {
          sameContactFieldTurns = 1;
          lastContactField = interaction.field;
        }
        // Only rotate when CRM says the number is occupied — a repeated
        // phoneNumber prompt is the normal unresolved-contact ladder.
        if (interaction.field === "phoneNumber" && interaction.occupied) {
          autopilotOpts.phone = uniqueSmokePhone();
        }
        if (sameContactFieldTurns >= 6) {
          throw new SmokeAssertError(
            `${options.scenario}: stuck on contact_field=${interaction.field}${interaction.occupied ? " (occupied)" : ""} after ${sameContactFieldTurns} turns`,
          );
        }
      } else {
        lastContactField = null;
        sameContactFieldTurns = 0;
      }

      const next = nextAutopilotInput(
        {
          pendingInteraction: last.state.pendingInteraction,
          pendingConfirm: last.pendingConfirm,
        },
        autopilotOpts,
      );
      if (next == null) {
        break;
      }
      // Prefer tap when the label is on the current keyboard (HITL / chips).
      last = lastButtons.includes(next) ? await tap(next) : await say(next);
      collected.push(last);
      if (
        opts.decision === "confirm"
        && last.calls.some((call) => call.name === "create_meeting")
        && !last.pendingConfirm
        && last.state.pendingInteraction?.kind !== "mutation_confirm"
      ) {
        break;
      }
      if (
        opts.decision === "decline"
        && !last.pendingConfirm
        && last.state.pendingInteraction?.kind !== "mutation_confirm"
        && collected.some((turn) => turn.pendingConfirm || turn.state.pendingInteraction?.kind === "mutation_confirm")
      ) {
        break;
      }
    }

    if (collected.length === 0) {
      throw new SmokeAssertError(
        `${options.scenario}: autopilot made no progress (pending=${last.state.pendingInteraction?.kind ?? "null"})`,
      );
    }
    return { turns: collected, last };
  };

  const snapshot = async (): Promise<TurnResult> => {
    const { state, pendingConfirm } = await readStateSnapshot(graph, threadId);
    return {
      reply: "",
      buttons: lastButtons,
      state,
      calls: [],
      pendingConfirm,
    };
  };

  return {
    get telegramId() {
      return options.telegramId;
    },
    get threadId() {
      return threadId;
    },
    get scenario() {
      return options.scenario;
    },
    get turns() {
      return turns;
    },
    say,
    tap,
    autopilotBooking,
    snapshot,
  };
};

/** Seed lastButtons after a say that opened a keyboard (for first tap). */
export const sessionButtons = (turn: TurnResult): string[] => turn.buttons;
