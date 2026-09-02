---
name: langsmith-clinic-bot
description: >-
  Query LangSmith traces for clinic-appointment-bot analytics and debugging
  (clinic-turn roots, Telegram threads, Tier 1 booking events, tool_error).
  Default-filter metadata.telegram_user_id to 1363967211 and 286834869.
  Display conversations, turn lists, and metric tables in a Cursor canvas.
  Use when the user asks about LangSmith, traces, last runs, funnel metrics,
  booking success/cancel/reschedule, latency, or debugging a Telegram chat.
---

# LangSmith for clinic-appointment-bot

Read this skill before querying traces. Use the LangSmith MCP, not ad-hoc HTTP.

## Access

1. Discover tools in namespace `user-LangSmith` (Cursor prefix of MCP server `LangSmith`).
2. If the namespace is missing or not `ready`, check `~/.cursor/mcp.json` and `.cursor/mcp.json` for a **stdio** `LangSmith` server (`npx -y langsmith-mcp-server`) with `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT` (EU), and `LANGSMITH_WORKSPACE_ID` set in `env` — do not copy those values into this skill or into chat.
3. Do **not** call `mcp_auth`. Auth is the API key in MCP `env`. Never print API keys or raw MCP headers.

**Project:** `clinic-appointment-bot` (resolve org/project ids and the EU UI base URL from `list_projects` / run `app_path`, not from hardcoded credentials here).  
**Peek a trace:** open the project UI and append `?peek=<trace_id>`.

If listing workspaces shows a tenant other than the one in MCP `env`, pass that workspace id only for that call — never store it in this file.

## Trace model

Each Telegram (or smoke) message is its own **root** run:

| Field | Value |
| --- | --- |
| `name` | `clinic-turn` |
| `run_type` | `chain` |
| `is_root` | true |
| tags | `telegram` (prod) or `smoke` |
| metadata | `telegram_user_id`, `chat_id`, `source`, `thread_id` |
| LangGraph `thread_id` | Telegram `chat.id` (same as `chat_id`) |

Child **Tier 1** events are named chain runs posted by `trackEvent` in `src/analytics/track.ts`. They are PII-safe (ids, counts, dates, field names, truncated `error_message`). `ANALYTICS_DISABLED=1` skips these events only; LLM tracing still runs.

**Privacy:** unless `LANGSMITH_TRACE_CONTENT=true`, LLM/tool inputs and outputs are redacted. Metadata is not. Do not dump full patient chat into PRs or unrelated files. Show logs in a canvas; keep the chat reply to a short summary.

`booking_session_id` is **not** in production yet. Do not filter on it. Cost today is per `clinic-turn` / LLM child, not per visit.

## Default operator filter

Unless the user names another Telegram user or explicitly asks for **all** traffic, only include traces for:

- `1363967211`
- `286834869`

LangSmith metadata key is **`telegram_user_id`** (not `telegram_id`). In private chats this is also `chat_id` / `thread_id`.

**Do not** use `or(...)` across two `metadata_key`/`metadata_value` pairs — LangSmith returns 400 (`OR operator cannot be used across different tables`).

Primary patterns (pick one):

1. **Two single-user queries** (preferred when you need server-side filter): run `fetch_runs` / `get_thread_history` once per id, then merge by `start_time` desc.
2. **Client-side filter**: one wider `fetch_runs` page, keep only rows whose `extra.metadata.telegram_user_id` (or equivalent) is in the set above.

Single-user FQL (AND with other predicates):

```
and(eq(metadata_key, "telegram_user_id"), eq(metadata_value, "1363967211"))
```

## MCP calls

Always set `project_name` to `clinic-appointment-bot`. Restrict results to the two operator ids via the patterns above (never the dual-user OR).

**Latest turns**

- Prefer two parallel `fetch_runs` calls (one per operator id), each: `is_root=true`, `limit` 15–30, `order_by=-start_time`, `preview_chars` 200
- Per-call `filter`: `and(eq(name, "clinic-turn"), and(eq(metadata_key, "telegram_user_id"), eq(metadata_value, "<id>")))` — or `eq(name, "clinic-turn")` / `has(tags, "telegram")` plus client-side id filter
- Merge both result lists by `start_time` desc before answering

**One conversation**

- Prefer recent `clinic-turn` roots (`order_by=-start_time`) for the chat id; `get_thread_history` page 1 is oldest-first and may need late pages.
- Default: both operator ids (two queries), pick the newest thread by `start_time`.
- Render the transcript in a canvas (see Display); chat gets only a short summary + canvas link.

**Drill into a turn**

- `fetch_runs` with `trace_id=<root id>` (root id equals `trace_id` for `clinic-turn`)
- For Gemini schemas: same `trace_id`, `run_type=llm`, `include_invocation_params=true`

**Funnel / errors**

- Same dual-query or client-side id restriction
- `is_root=false` (or omit), `filter` on event `name` (see catalog below)
- Errored roots: `is_root=true`, `error=true`
- `tool_error` children: `filter=eq(name, "tool_error")`

Useful FQL:

```
eq(name, "clinic-turn")
has(tags, "telegram")
eq(name, "meeting_created")
and(eq(name, "tool_error"), eq(run_type, "chain"))
and(eq(metadata_key, "telegram_user_id"), eq(metadata_value, "<id>"))
```

If any filter 400s, drop that FQL clause and still restrict client-side to the two operator ids.

## Event catalog

Use these `name` values (not guessed synonyms):

| Name | Meaning |
| --- | --- |
| `contact_lookup_telegram` / `contact_lookup_phone` | CRM identity lookup (`outcome` success / not_found / error) |
| `contact_created` / `contact_telegram_linked` / `contact_updated` | Contact writes |
| `contact_incomplete_blocked` | Booking blocked on missing fields |
| `availability_presented` | Slots shown (`date`, `slot_count`) |
| `booking_confirmation_requested` | HITL Yes/No shown (`outcome=awaiting`) |
| `booking_awaiting_chat_confirm` | User typed instead of tapping Yes/No |
| `booking_declined` | User tapped No |
| `meeting_created` / `meeting_cancelled` / `meeting_rescheduled` | CRM visit write committed |
| `tool_error` | Tool failure (`tool`, truncated `error_message`) |
| `reply_menu_filled` | Graph filled a missing visit-change reply keyboard |

Outcomes: `success` \| `error` \| `not_found` \| `declined` \| `awaiting`.

Code map: adapter `src/adapter/telegram-bot.ts` (`graphInvokeConfig`); events from `src/tools/*` and `src/graph/supervisor.ts`.

## Workflows

**Debug a bad reply / failed booking**

1. Fetch recent operator `clinic-turn` roots (or `get_thread_history` for those two chat ids).
2. Identify the turn from input/output preview, time, and latency.
3. Fetch that `trace_id`. Look for `tool_error`, HITL events, and whether `meeting_*` fired.
4. Map the failure: LLM chose wrong tool vs CRM `{ error }` vs HITL not resumed vs keyboard/menu.
5. Lead with the diagnosis and the peek URL in chat. Put the turn/event log in a canvas (see Display). Cite 1–3 traces, not a dump.

Typical patterns:

- Input `Command` = Telegram callback (button), not typed text.
- HITL confirm is a **new** `clinic-turn` after the interrupt turn.
- Echo-only output preview (human text in both in/out) often means graph state update without a new AI message.

**Analytics (funnel, volume, latency)**

1. Default to the two operator ids. Time-bound with `min_start_time` / `max_start_time` (RFC3339, UTC).
2. Count roots (`clinic-turn`) vs `meeting_created` / `cancelled` / `rescheduled`.
3. Drop-off: `availability_presented` → `booking_confirmation_requested` → `meeting_created`.
4. `tool_error` grouped by `inputs`/`metadata.tool`.
5. Latency: `latency_seconds` on `clinic-turn` (p50/p95 from the page; say if the page is truncated).
6. Render the metrics/tables in a canvas (see Display). One-line “what happened?” answers may stay in chat only.

## Display (canvas for logs)

When the deliverable is a conversation, turn list, funnel table, latency table, or other multi-row log — **write a Cursor canvas**, do not dump markdown tables or long transcripts into chat. Read `~/.cursor/skills-cursor/canvas/SKILL.md` first.

**Path:** `/root/.cursor/projects/root-agents-espocrm-appointment-bot-dev/canvases/<name>.canvas.tsx`  
Reuse or update `clinic-appointment-bot-traces.canvas.tsx` for operator turn logs when that fits; otherwise a descriptive kebab-case name (e.g. `clinic-conversation-<telegram_user_id>.canvas.tsx`).

**Rules:**

- Import only from `cursor/canvas`. Embed data inline (no `fetch`). Default-export one component.
- Prefer `Table` / `Stack` / `Stat` / `Link` for turn logs; include UTC time, latency, user/bot text (truncated), status, and peek `Link` per row or for the session.
- Conversation view: chronological user↔bot turns (skip system_metadata / tool JSON blobs unless debugging tools). Header: telegram user id, contact name if known, time range, project peek.
- Chat reply: 1–3 sentence summary + markdown link to the `.canvas.tsx` file (full absolute path). Do not restate the full log in chat.
- Skip canvas only for a single factual answer with no list/transcript (e.g. one peek URL, yes/no).

## Response rules

- Times in **UTC**; mention local (UTC+7) only if the user is comparing to Telegram.
- Link LangSmith peek URLs for traces you discuss (in canvas and/or the short chat summary).
- Never paste `LANGSMITH_API_KEY` or raw MCP headers.
- Do not treat empty LLM inputs as a bot bug when content tracing is off.
- Do not dump full patient chat into PRs or unrelated files; canvas is the display surface for logs.
