# Clinic Appointment Bot

Thin LangGraph clinic bot for Telegram. FAQ + booking/cancel/reschedule via EspoCRM MCP, Gemini supervisor routing, telegraf long polling with HITL Yes/No confirm.

## Setup

EspoCRM MCP must already be running (HTTP/SSE). CRM API secrets live on that service, not this bot.

```sh
pnpm install
cp .env.example .env
# set GOOGLE_API_KEY, ESPOCRM_ASSIGNED_USER_ID
# set ESPOCRM_MCP_URL=http://127.0.0.1:3000/sse for local MCP
# set TELEGRAM_BOT_TOKEN to launch the bot
# optional: SMOKE_KNOWN_TELEGRAM_ID for --identity known path
# optional LangSmith: LANGSMITH_TRACING=true LANGSMITH_API_KEY= LANGSMITH_PROJECT=clinic-appointment-bot
```

## LangSmith

Set `LANGSMITH_TRACING=true` plus `LANGSMITH_API_KEY` to send LangGraph traces to LangSmith (`LANGCHAIN_TRACING_V2` / `LANGCHAIN_API_KEY` aliases also work). Optional `LANGSMITH_PROJECT` (example: `clinic-appointment-bot`) and `LANGSMITH_ENDPOINT` (EU / self-hosted). Telegram and smoke invokes tag each turn as `clinic-turn` with `telegram_user_id` and `chat_id` metadata. Tier 1 booking events (`meeting_created`, `contact_created`, …) are posted as named runs (filter by run name; they may be flat rather than nested under the tool span). `ANALYTICS_DISABLED=1` skips those events only; LLM tracing still runs.

## Docker

Start the sibling MCP stack first (`espocrm-mcp-server` on network `espocrm-mcp_default`). Then:

```sh
docker compose up -d --build
```

Compose sets `ESPOCRM_MCP_URL=http://espocrm-mcp-server:3000/sse`. Bot `.env` still needs `GOOGLE_API_KEY`, `ESPOCRM_ASSIGNED_USER_ID`, and `TELEGRAM_BOT_TOKEN`.

## Commands

```sh
pnpm check   # typecheck
pnpm test    # unit tests (identity, HITL, slots, Telegram UI, graph)
pnpm test:all  # app + llm-gemini package tests
pnpm depcruise  # dependency rules (cycles, orphans, missing deps)
pnpm depcruise:graph  # write dependency-graph.mmd (Mermaid)
pnpm depcruise:graph:svg  # write dependency-graph.svg (needs Graphviz `dot`)
pnpm smoke   # bootstrap + live MCP SSE (`ESPOCRM_MCP_URL`)
pnpm smoke -- --invoke    # FAQ routing via Gemini
pnpm smoke -- --identity  # known vs unknown telegram_id booking smoke
pnpm dev     # boot runtime; start Telegram polling when TELEGRAM_BOT_TOKEN is set
```

## Layout

- `src/graph/` — thin LangGraph (supervisor + faq/booking agent loops)
- `src/composition/` — runtime wiring, MCP adapters, build-time agents
- `src/analytics/` — Tier 1 booking-funnel events (`trackEvent` → LangSmith child runs)
- `src/tools/` — EspoCRM MCP LangChain tools, availability free/busy, telegram user context (ALS)
- `src/adapter/` — telegraf bot (`telegram-bot.ts`) + Inline Keyboard helpers (`telegram-ui.ts`)
- `src/prompts/` — supervisor / FAQ / booking prompts (source of truth with `src/composition/agents.ts`)
- `packages/llm-gemini` — Gemini connector + explicit context cache for supervisor routing (`GEMINI_CONTEXT_CACHE`, default on)

## FAQ / services

- Catalog questions (`list_services`): short categorized summary; **no prices** in the tool payload or reply
- Pricing: `get_service` for the matched service only; quote only what the user asked for
- USD → UAH: when CRM `priceCurrency` is USD, `get_service` fetches `usd.uah` from [currency-api](https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json) and attaches `priceUah`; FAQ quotes it only if the user asks in UAH (FX failure → native USD, no invented rates)

## Booking tools

Meeting tools (booking agent):

- `present_availability_slots` — free/busy from `search_meetings`; optional `excludeMeetingIds` when rescheduling
- `create_meeting` — HITL Yes/No, then MCP `create_meeting`
- `list_planned_meetings` — upcoming Planned meetings for a Contact (`search_entity`)
- `cancel_meeting` — HITL Yes/No, then soft cancel (`update_meeting` status `Not Held`)
- `reschedule_meeting` — HITL Yes/No, then in-place `dateStart`/`dateEnd` update

## Telegram behaviour

- `/start` replies with a static intro and categorized services (no prices); working hours come from CRM `get_working_time`; the same text is appended to the chat's graph message history as an `AIMessage` so later agent turns see it
- `thread_id = chat.id`; per-chat exclusive graph invoke queue
- Each turn runs under `runWithTelegramUserId(from.id)` (CRM `cTelegram`)
- `present_availability_slots` uses `search_meetings` free/busy; agent lists times in text (Inline Keyboard temporarily disabled)
- HITL confirm: tap Yes/No to resume with `Command`. Typing while the confirm card is pending sends the text into the interrupt (`userReply`); the tool returns `awaitingConfirmation` (nothing written). If the user affirmed, the model re-calls the same tool with `confirmationGiven: true`. Chat text never implicitly cancels.
- After button Yes/No, the bot removes the inline keyboard, then replies with the agent outcome.

## Manual E2E checklist

1. Known Telegram user: booking skips phone/name after `cTelegram` lookup
2. Incomplete CRM contact (missing firstName/lastName/phone): collect them at book time, then `update_contact` before confirm
3. Unknown user: asks phone/name, create/link writes `cTelegram`
4. FAQ: hours/services from CRM; catalog has no prices; UAH ask on a USD service uses `priceUah`
5. Type a slot time from the agent's text list (Inline Keyboard disabled)
6. Tap Confirm Yes to book; Confirm No cancels without CRM write. Typing after the card (e.g. `так`) is handled by the agent re-calling the tool with `confirmationGiven: true`
7. After Yes/No, agent continues; button path removes the inline keyboard
8. Cancel: list upcoming visits → Confirm Yes soft-cancels (`Not Held`)
9. Reschedule: pick new slot (old slot offered via `excludeMeetingIds`) → Confirm Yes updates times
10. No recursion-limit loops after clarifying questions
