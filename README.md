# Clinic Appointment Bot (Phase 2)

Supervisor-framework pack for a Telegram clinic bot. Phase 2 wires EspoCRM MCP capabilities (`espocrm-read` / `espocrm-booking`), identity tools (`cTelegram`), and HITL `interrupt` on `create_meeting`. Telegram UI lands in Phase 4.

## Setup

```sh
pnpm install
cp .env.example .env
# set GOOGLE_API_KEY, ESPOCRM_URL, ESPOCRM_API_KEY, ESPOCRM_ASSIGNED_USER_ID
```

## Commands

```sh
pnpm check   # typecheck
pnpm test    # identity + HITL unit tests
pnpm smoke   # bootstrap + live MCP stdio connect
pnpm smoke -- --invoke  # also call Gemini
pnpm dev     # print runtime status
```

## Layout

- `src/composition/` — pack bootstrap, MCP adapters, capability providers
- `src/tools/` — EspoCRM MCP LangChain tools + telegram user context
- `src/prompts/` — supervisor / FAQ / booking prompts
- `src/llm/` — Gemini `ILLMConnector`
- `src/adapter/` — Telegram (Phase 4)
- `data/` — `runtime-agents.json`, `cron-jobs.json`
- `packages/langgraph-supervisor-expert-bootstrap` — supervisor framework workspace package
