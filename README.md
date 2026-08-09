# Clinic Appointment Bot

Thin LangGraph clinic bot for Telegram. FAQ + booking/cancel/reschedule via EspoCRM MCP, Gemini supervisor routing, telegraf long polling with HITL Yes/No confirm.

## Setup

```sh
pnpm install
cp .env.example .env
# set GOOGLE_API_KEY, ESPOCRM_URL, ESPOCRM_API_KEY, ESPOCRM_ASSIGNED_USER_ID
# set TELEGRAM_BOT_TOKEN to launch the bot
# optional: SMOKE_KNOWN_TELEGRAM_ID for --identity known path
```

## Commands

```sh
pnpm check   # typecheck
pnpm test    # unit tests (identity, HITL, slots, Telegram UI, graph)
pnpm test:all  # app + llm-gemini package tests
pnpm depcruise  # dependency rules (cycles, orphans, missing deps)
pnpm depcruise:graph  # write dependency-graph.mmd (Mermaid)
pnpm depcruise:graph:svg  # write dependency-graph.svg (needs Graphviz `dot`)
pnpm smoke   # bootstrap + live MCP stdio
pnpm smoke -- --invoke    # FAQ routing via Gemini
pnpm smoke -- --identity  # known vs unknown telegram_id booking smoke
pnpm dev     # boot runtime; start Telegram polling when TELEGRAM_BOT_TOKEN is set
```

## Layout

- `src/graph/` — thin LangGraph (supervisor + faq/booking agent loops)
- `src/composition/` — runtime wiring, MCP adapters, build-time agents
- `src/tools/` — EspoCRM MCP LangChain tools, availability free/busy, telegram user context (ALS)
- `src/adapter/` — telegraf bot (`telegram-bot.ts`) + Inline Keyboard helpers (`telegram-ui.ts`)
- `src/prompts/` — supervisor / FAQ / booking prompts (source of truth with `src/composition/agents.ts`)
- `packages/llm-gemini` — Gemini connector + explicit context cache for supervisor routing (`GEMINI_CONTEXT_CACHE`, default on)

## Booking tools

Meeting tools (booking agent):

- `present_availability_slots` — free/busy from `search_meetings`; optional `excludeMeetingIds` when rescheduling
- `create_meeting` — HITL Yes/No, then MCP `create_meeting`
- `list_planned_meetings` — upcoming Planned meetings for a Contact (`search_entity`)
- `cancel_meeting` — HITL Yes/No, then soft cancel (`update_meeting` status `Not Held`)
- `reschedule_meeting` — HITL Yes/No, then in-place `dateStart`/`dateEnd` update

## Telegram behaviour

- `thread_id = chat.id`; per-chat exclusive graph invoke queue
- Each turn runs under `runWithTelegramUserId(from.id)` (CRM `cTelegram`)
- `present_availability_slots` uses `search_meetings` free/busy; agent lists times in text (Inline Keyboard temporarily disabled)
- HITL confirm is **button-only**: tap Confirm Yes/No (`Command` resume). Typing "Yes"/"No" as text starts a new turn, not a HITL resume.
- After Yes/No, the bot edits the confirm message (appends ✓ Confirmed / ✗ Cancelled) and removes the inline keyboard, then replies with the agent outcome.

## Manual E2E checklist

1. Known Telegram user: booking skips phone/name after `cTelegram` lookup
2. Unknown user: asks phone/name, create/link writes `cTelegram`
3. FAQ: hours/services answered from CRM tools
4. Type a slot time from the agent's text list (Inline Keyboard disabled)
5. Tap Confirm Yes to book; Confirm No cancels without CRM write
6. After Yes/No, confirm message shows status and buttons disappear
7. Cancel: list upcoming visits → Confirm Yes soft-cancels (`Not Held`)
8. Reschedule: pick new slot (old slot offered via `excludeMeetingIds`) → Confirm Yes updates times
9. No recursion-limit loops after clarifying questions
