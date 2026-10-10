import type { ClinicRuntime } from "../composition/clinic-runtime.js";
import type { BookingDraft } from "../graph/booking-draft.js";
import type { PendingInteraction } from "../graph/booking-session.js";
import type { ClinicHandoff } from "../graph/types.js";
import type { McpCallTool } from "../shared/mcp.js";
import type { AvailabilityContext } from "../tools/availability-tools.js";

export type SmokeTier = "deterministic" | "invoke" | "write";

export type SmokeStatus = "pass" | "warn" | "fail" | "skip";

export type CallRecord = {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  /** Set when the MCP call threw; result is omitted. */
  error?: string;
};

export type SmokeStateSnapshot = {
  pendingInteraction: PendingInteraction | null;
  bookingDraft: BookingDraft | null;
  lastHandoff: ClinicHandoff | null;
  contactContext: unknown;
  bookingContext: unknown;
  availabilityContext: AvailabilityContext | null;
};

export type SoftWarning = {
  label: string;
  detail?: string;
};

export type ScenarioResult = {
  name: string;
  tier: SmokeTier;
  status: SmokeStatus;
  turns: number;
  durationMs: number;
  warnings: SoftWarning[];
  error?: string;
};

export type ScenarioContext = {
  runtime: ClinicRuntime;
  callTool: McpCallTool;
  cleanup: CleanupRegistryLike;
  supportsDeleteEntity: boolean;
  /** True when SMOKE_ALLOW_WRITES and the production/remote CRM guards pass. */
  writesAllowed: boolean;
  env: SmokeEnv;
};

export type SmokeEnv = {
  knownTelegramId?: string | undefined;
  telegramIdA: string;
  allowWrites: boolean;
  allowRemoteCrm: boolean;
  nodeEnv: string;
};

export type CleanupRegistryLike = {
  trackMeeting: (meetingId: string) => void;
  trackContact: (contactId: string) => void;
  run: () => Promise<void>;
};

export type ScenarioRunOutcome = {
  warnings?: SoftWarning[];
  turns?: number;
};

export type SmokeScenario = {
  name: string;
  tier: SmokeTier;
  run: (ctx: ScenarioContext) => Promise<ScenarioRunOutcome | void>;
};
