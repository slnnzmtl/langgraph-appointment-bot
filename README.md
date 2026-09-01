# Clinic Appointment Bot

Telegram AI for a cosmetic clinic. Patients chat in private Telegram; the bot answers clinic FAQ and books / moves / cancels visits in EspoCRM via MCP (Gemini supervisor + FAQ / booking specialists, telegraf long polling, HITL ✅/❌). Ukrainian-first; replies in the patient’s language.

Product topology, routing, and change map: [AGENT.md](AGENT.md).

## Setup

EspoCRM MCP must already be running (HTTP). This bot sends `ESPOCRM_API_KEY` as the `espocrm_api_key` header.

```sh
pnpm install
cp .env.example .env
# set GOOGLE_API_KEY, ESPOCRM_API_KEY, ESPOCRM_ASSIGNED_USER_ID
# set ESPOCRM_MCP_URL=http://127.0.0.1:3000 for local MCP
# set TELEGRAM_BOT_TOKEN to launch the bot
# optional: WEBHOOK_SECRET to enable POST /webhooks/tomorrow-reminder (compose: 127.0.0.1:8080)
# optional: SMOKE_KNOWN_TELEGRAM_ID for --identity known path
# optional LangSmith: LANGSMITH_TRACING=true LANGSMITH_API_KEY= LANGSMITH_PROJECT=clinic-appointment-bot
```

## LangSmith

Set `LANGSMITH_TRACING=true` plus `LANGSMITH_API_KEY` to send LangGraph traces to LangSmith (`LANGCHAIN_TRACING_V2` / `LANGCHAIN_API_KEY` aliases also work). Optional `LANGSMITH_PROJECT` (example: `clinic-appointment-bot`) and `LANGSMITH_ENDPOINT` (EU / self-hosted). When tracing is on, LLM and tool **inputs/outputs are redacted** (empty payloads) so patient chat does not leave the process. Set `LANGSMITH_TRACE_CONTENT=true` only for a trusted, EU, or self-hosted project if you need the raw spans. Run metadata still includes `telegram_user_id` and `chat_id`. Telegram and smoke invokes tag each turn as `clinic-turn`. Tier 1 booking events (`meeting_created`, `contact_created`, …) are posted as named runs with PII-safe props (ids, counts, dates, field names) and are not redacted. `ANALYTICS_DISABLED=1` skips those events only; LLM tracing still runs.

## Docker

Start the sibling MCP stack first (`espocrm-mcp-server` on network `espocrm-mcp_default`). Then:

```sh
docker compose up -d --build
```

Compose sets `ESPOCRM_MCP_URL=http://espocrm-mcp-server:3000`. Bot `.env` still needs `GOOGLE_API_KEY`, `ESPOCRM_API_KEY`, `ESPOCRM_ASSIGNED_USER_ID`, and `TELEGRAM_BOT_TOKEN`. The image runs as the non-root `node` user on a digest-pinned `node:20.20-alpine3.22` base.

### Tomorrow-reminder webhook

When both `TELEGRAM_BOT_TOKEN` and `WEBHOOK_SECRET` are set, the process also listens for `POST /webhooks/tomorrow-reminder` (default port `8080`, override with `WEBHOOK_PORT`). Compose maps **`127.0.0.1:8080:8080`** so the port is not reachable from the public internet. Use a long random `WEBHOOK_SECRET` (header `X-Webhook-Secret`).

**Public HTTPS (Caddy on this host):** EspoCRM should call:

`https://<public-host>/webhooks/tomorrow-reminder`

Host Caddy ([`deploy/Caddyfile`](deploy/Caddyfile) → `/etc/caddy/Caddyfile`) terminates TLS, allowlists EspoCRM egress **IPv4**, and reverse-proxies the same path to `http://127.0.0.1:8080`. Other client IPs and paths get `403`. Bind Caddy to the public IPv4 only so it does not clash with Tailscale on `:443`. After editing the repo file, copy it to `/etc/caddy/Caddyfile` (do not symlink under `/root` — the `caddy` user cannot read it) and `systemctl restart caddy`.

```sh
# Loopback (on the bot host) — HITL needs id (+ status Planned)
curl -sS -X POST http://127.0.0.1:8080/webhooks/tomorrow-reminder \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -d '{"telegramId":"123456789","meetings":[{"id":"meetIdHere","name":"Консультація","dateStart":"2026-08-22T10:00:00","status":"Planned"}]}'

# From EspoCRM (allowlisted egress IP)
curl -sS -X POST https://<public-host>/webhooks/tomorrow-reminder \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -d '{"telegramId":"123456789","meetings":[{"id":"meetIdHere","name":"Консультація","dateStart":"2026-08-22T10:00:00","status":"Planned"}]}'
```

Body: `telegramId` (string or number) and `meetings` (at least one `{ name, dateStart }`; optional `id` / `meetingId` / `status`). Success: `{ "ok": true, "hitl": boolean }`. EspoCRM controls **when** the webhook fires (minutes before, evening before, etc.); the bot adapts the Ukrainian intro from each meeting’s `dateStart` vs Kyiv now («через N хв», «сьогодні», «завтра», or a generic line). `dateStart` may be Kyiv wall time without a zone, or ISO-8601 with `Z` / ±offset (converted to Europe/Kyiv for copy).

**Reminder HITL:** when status is **Planned** (or omitted) and `id` (or `meetingId`) is present, the bot sends ✅/❌ and sets CRM status to `Confirmed` (✅) or `Not Held` (❌). Pending confirm lasts until that visit’s **start** (`dateStart` from the last HITL reminder); a new HITL POST (e.g. after reschedule) replaces pending. Without `id`, response is still `{ "ok": true, "hitl": false }` (notify-only). «Головне меню» dismisses the confirm card without changing CRM. Already-`Confirmed` visits get a notify-only reminder (no keyboard). EspoCRM reminder POSTs must include Meeting `id` and preferably `status`.

## Commands

```sh
pnpm check   # typecheck
pnpm test    # unit tests (identity, HITL, slots, Telegram UI, graph)
pnpm test:all  # app + llm-gemini package tests
pnpm depcruise  # dependency rules (cycles, orphans, missing deps)
pnpm depcruise:graph  # write dependency-graph.mmd (Mermaid)
pnpm depcruise:graph:svg  # write dependency-graph.svg (needs Graphviz `dot`)
pnpm smoke   # bootstrap + live MCP HTTP (`ESPOCRM_MCP_URL`)
pnpm smoke -- --invoke    # FAQ routing via Gemini
pnpm smoke -- --identity  # known vs unknown telegram_id booking smoke
pnpm dev     # boot runtime; start Telegram polling when TELEGRAM_BOT_TOKEN is set
```

## Layout

- `AGENT.md` — product map (agents, routing, write/HITL invariants, where to edit)
- `src/graph/` — LangGraph (supervisor + faq/booking loops, sticky routing, prefetch)
- `src/composition/` — runtime wiring, MCP adapters, agent defs (`maxSteps`)
- `src/prompts/` — supervisor / FAQ / booking plus shared `VOICE_*` sections in `voice.ts`
- `src/tools/` — EspoCRM MCP LangChain tools, availability free/busy, telegram user context (ALS)
- `src/adapter/` — telegraf (`telegram-bot.ts`), keyboards (`telegram-ui.ts`), `/start` welcome, reminder webhook
- `src/shared/` — clinic constants (address, consultation id, menu labels), helpers
- `src/analytics/` — Tier 1 booking-funnel events (`trackEvent` → LangSmith child runs)
- `packages/llm-gemini` — Gemini connector + explicit context cache (`GEMINI_CONTEXT_CACHE`, default on)

## FAQ / services

- Catalog (`list_services`): grouped summary; **no prices** in the tool payload or reply. Closes with a consultation offer («Так» / «Обрати іншу процедуру»). «Обрати іншу процедуру» drills the catalog one level per message (FAQ), then offers to book that procedure.
- Pricing: `get_service` for the matched service only; quote only what the user asked for.
- USD → UAH: when CRM `priceCurrency` is USD, `get_service` fetches `usd.uah` from [currency-api](https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json) and attaches `priceUah`; FAQ quotes it only if the user asks in UAH (FX failure → native USD, no invented rates).

## Booking tools

Default visit is **Консультація** unless the patient is sure about a named procedure (or FAQ already chose one). Catalog browse is FAQ; booking may `list_services` once to match a typed CRM name.

- `present_availability_slots` — free/busy from `search_meetings` and `CReservedTime`; optional `excludeMeetingIds` when rescheduling (current start is not listed)
- `create_meeting` — HITL Yes/No, then MCP `create_meeting`
- `list_planned_meetings` — upcoming Planned meetings for a Contact (`search_entity`)
- `cancel_meeting` — HITL Yes/No, then soft cancel (`update_meeting` status `Not Held`)
- `reschedule_meeting` — HITL Yes/No, then in-place `dateStart`/`dateEnd` update
- Contact tools (`find_contact_by_phone`, `create_contact`, `link_telegram_to_contact`, `update_contact`) — identity; phone/name only after a slot is chosen

## Telegram behaviour

- `/start` sends two messages: a static intro (identity, capabilities, medical disclaimer, address) plus CRM working hours from `get_working_time`, then a short follow-up. Both attach **DEFAULT MENU** (no visits → «Записатись», «Послуги», «Адреса»; has a visit → «Мій запис», «Послуги», «Адреса»; plus «Головне меню»), using a Telegram contact + planned-meetings lookup. Checkpointed history stores `WELCOME_HISTORY_MARKER` + the follow-up, not the full welcome, so later hellos stay short.
- Private chats only (groups get a short redirect); 20 messages per user per minute (text, voice, `/start`, and reply-keyboard taps)
- `thread_id = chat.id`; per-chat exclusive graph invoke queue
- Conversation and HITL state live in process memory (`MemorySaver` plus a pending-confirm map). A restart clears chats; there is no long-term transcript store. Run a single bot instance.
- SIGINT/SIGTERM stop Telegram polling, wait for in-flight handler work, then abort in-flight EspoCRM MCP HTTP calls (`shutdownAdapters`). MCP `/health` is checked at process start; later MCP outages fail the tool call (30s timeout).
- Each turn runs under `runWithTelegramUserId(from.id)` (CRM `cTelegram`)
- Meeting writes (`create_meeting`, `cancel_meeting`, `reschedule_meeting`) and `list_planned_meetings` require the Contact/`meetingId` to belong to that Telegram user
- At most one Planned meeting per patient: `create_meeting` is blocked until the existing visit is cancelled; then the new slot can be booked. Do not offer reschedule during that conflict — reschedule is only after «Мій запис»
- Supervisor prefetches contact + planned meetings into checkpointed state; booking prepare reuses that snapshot until a successful CRM write dirties it or the snapshot is older than ~5 minutes.
- Sticky routing: tapping a shortcut the specialist just offered continues in that agent (skips the supervisor LLM). FAQ book-handoff offers include a hidden `<yield_to_supervisor/>` so «Так» is re-routed to booking. «Перенести» / «Скасувати» go to booking even after a FINISH visit list or an Already-booked replace offer
- `present_availability_slots` uses `search_meetings` and `CReservedTime` free/busy; booking finalize attaches DATE then TIME reply keyboards from the tool snapshot (`dayLabel` / slot labels precomputed in TS). The user may still type a slot. `whenLabel` / `visitLabel` for planned meetings are also precomputed so the model quotes them instead of formatting dates itself
- When the next step is a short choice, the agent may append a hidden `<reply_buttons>` trailer; the adapter strips it and shows a one-time Telegram **reply keyboard**. Tapping a label sends that text as a normal message. Every keyboard ends with **«Головне меню»** (adapter-appended, including HITL and turns with no other shortcuts). Supervisor **FINISH** must emit that trailer itself: DEFAULT MENU, or VISIT CHANGE («Перенести», «Скасувати», «Ні, дякую») after an explicit visit inquiry — the server does not fill these. `/start` and reminders still use `buildDefaultMenuKeyboard`. When `create_meeting` returns `Already booked`, the booking agent must emit REPLACE («Скасувати», «Ні, дякую») in `<reply_buttons>` — never «Перенести». Consultation and book-this-procedure yes/no offers must use «Так» / «Обрати іншу процедуру» in `<reply_buttons>` (FAQ adds `<yield_to_supervisor/>` on «Так»). DATE/TIME shortcuts (dates plus «Інша дата», then HH:mm) come from the graph snapshot, not a model trailer. «Головне меню» routes to a short idle reply with DEFAULT MENU; during HITL it declines the write. English aliases (Book / Services / Address / …) are recognized for routing.
- Book/move success includes clinic address + Maps; cancel does not.
- Internal failures (routing, model call, step limit) reply with `PATIENT_FALLBACK_MESSAGE`; the raw error goes to the log only
- HITL confirm: meeting writes pause on a one-time **reply keyboard** with ✅ / ❌ (~15 min pending; replaces any prior date/time shortcuts). The agent must call the write tool on the same turn as a clear book/cancel/move intent — never a prior chat «підтвердити?». Tapping ✅ / ❌ resumes with `Command({ confirmed })`. Other text while the card is pending goes into the interrupt as `userReply`; the tool returns `awaitingConfirmation` (nothing written). If the user affirmed, the model re-calls the same tool with `confirmationGiven: true`. The server honors that flag only when a HITL card was already shown on this thread for the same write arguments. Chat text never implicitly cancels.
- Voice notes up to 60 seconds: Telegraf downloads the OGG, Gemini 3.1 Flash Lite transcribes it (`AUDIO_MODEL` optional), then the same text graph path runs; empty, failed, or longer recordings get a short Ukrainian fallback and do not invoke the graph. Replies are always text.

## Manual E2E checklist

1. `/start`: full welcome + hours (no service catalog), follow-up, DEFAULT MENU; a later «Привіт» is a short hello, not a second intro
2. Known Telegram user: booking skips phone/name after `cTelegram` lookup (details only after a slot if CRM fields are missing)
3. Incomplete CRM contact (missing firstName/lastName/phone): collect them at book time, then `update_contact` before confirm
4. Unknown user: asks phone/name after a slot, create/link writes `cTelegram`
5. FAQ: hours/services from CRM; catalog has no prices; UAH ask on a USD service uses `priceUah`. «Послуги» → consultation offer; «Обрати іншу процедуру» drills one catalog level per message
6. «Записатись» offers consultation («Так» / «Обрати іншу процедуру») before dates
7. Pick a date shortcut, then a time shortcut (or type a slot time from the agent's text list)
8. Tap ✅ to book; ❌ cancels without CRM write. Typing after the card (e.g. `так`) is handled by the agent re-calling the tool with `confirmationGiven: true`. A second Planned visit is refused until the first is cancelled (REPLACE shortcuts: cancel then book the new slot — never reschedule in that conflict). Success message includes address + Maps
9. After ✅/❌, agent continues; the next outbound reply replaces the reply keyboard
10. «Мій запис» lists visits with VISIT CHANGE; «Перенести» / «Скасувати» go to booking
11. Cancel: list upcoming visits → ✅ soft-cancels (`Not Held`)
12. Reschedule: pick a *different* slot (`excludeMeetingIds` frees the old block but does not list the current start) → ✅ updates times
13. No recursion-limit loops after clarifying questions
