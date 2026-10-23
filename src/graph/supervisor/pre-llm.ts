/**
 * Pre-LLM sticky / table routing was deleted (DDD-281).
 * Kept as a no-op so older tests that import resolvePreLlmRoute still compile
 * until they are retargeted to interpret + routeUnderstoodTurn.
 */
import type { SupervisorTurnContext } from "./context.js";
import type { RouteOutcome } from "./telemetry.js";

export type PreLlmRule = (ctx: SupervisorTurnContext) => RouteOutcome | null;

export const PRE_LLM_RULES: readonly PreLlmRule[] = [];

export const resolvePreLlmRoute = (
  _ctx: SupervisorTurnContext,
): RouteOutcome | null => null;
