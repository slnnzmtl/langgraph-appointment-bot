# Clinic Appointment Bot (Phase 4)

Supervisor-framework pack for a Telegram clinic bot. FAQ + booking via EspoCRM MCP, Gemini routing, telegraf long polling with Inline Keyboard slots and HITL Yes/No confirm.

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
pnpm test    # unit tests (identity, HITL, slots, Telegram UI)
pnpm smoke   # bootstrap + live MCP stdio + prompt sync check
pnpm smoke -- --invoke    # FAQ routing via Gemini
pnpm smoke -- --identity  # known vs unknown telegram_id booking smoke
pnpm dev     # boot runtime; start Telegram polling when TELEGRAM_BOT_TOKEN is set
```

## Layout

- `src/composition/` — pack bootstrap, MCP adapters, capability providers
- `src/tools/` — EspoCRM MCP LangChain tools, availability free/busy, telegram user context
- `src/adapter/` — telegraf bot (`telegram-bot.ts`) + Inline Keyboard helpers (`telegram-ui.ts`)
- `src/prompts/` — supervisor / FAQ / booking prompts (keep in sync with `data/runtime-agents.json`)
- `data/` — `runtime-agents.json`, `cron-jobs.json`
- `packages/langgraph-supervisor-expert-bootstrap` — supervisor framework workspace package
- `packages/llm-gemini` — Gemini connector + explicit context cache (`GEMINI_CONTEXT_CACHE`)

## Telegram behaviour

- `thread_id = chat.id`; per-chat exclusive graph invoke queue
- Each turn injects `from.id` via `setTelegramUserId` (CRM `cTelegram`)
- `present_availability_slots` uses `search_meetings` free/busy; agent lists times in text (Inline Keyboard temporarily disabled)
- `create_meeting` interrupts for Confirm Yes/No; resume with `{ confirmed: boolean }`

## Manual E2E checklist

1. Known Telegram user: booking skips phone/name after `cTelegram` lookup
2. Unknown user: asks phone/name, create/link writes `cTelegram`
3. FAQ: hours/services answered from CRM tools
4. Pick a slot from Inline Keyboard (or type a time)
5. Confirm Yes books; Confirm No cancels without CRM write
6. No recursion-limit loops after clarifying questions
