# Clinic Appointment Bot

Thin LangGraph clinic bot for Telegram. FAQ + booking via EspoCRM MCP, Gemini supervisor routing, telegraf long polling with HITL Yes/No confirm.

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
- `packages/llm-gemini` — Gemini connector (+ context cache helpers; not wired into supervisor yet)

## Telegram behaviour

- `thread_id = chat.id`; per-chat exclusive graph invoke queue
- Each turn runs under `runWithTelegramUserId(from.id)` (CRM `cTelegram`)
- `present_availability_slots` uses `search_meetings` free/busy; agent lists times in text (Inline Keyboard temporarily disabled)
- Booking confirm is **button-only**: tap Confirm Yes/No (`Command` resume). Typing "Yes"/"No" as text starts a new turn, not a HITL resume.

## Manual E2E checklist

1. Known Telegram user: booking skips phone/name after `cTelegram` lookup
2. Unknown user: asks phone/name, create/link writes `cTelegram`
3. FAQ: hours/services answered from CRM tools
4. Type a slot time from the agent's text list (Inline Keyboard disabled)
5. Tap Confirm Yes to book; Confirm No cancels without CRM write
6. No recursion-limit loops after clarifying questions
