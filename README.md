# Clinic Appointment Bot

Thin LangGraph clinic bot for Telegram. FAQ + booking/cancel/reschedule via EspoCRM MCP, Gemini supervisor routing, telegraf long polling with HITL Yes/No confirm.

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

`https://fedchenko.slnnzmtl.xyz/webhooks/tomorrow-reminder`

Host Caddy ([`deploy/Caddyfile`](deploy/Caddyfile) → `/etc/caddy/Caddyfile`) terminates TLS, allowlists EspoCRM egress **IPv4** `91.99.109.18`, and reverse-proxies the same path to `http://127.0.0.1:8080`. Other client IPs and paths get `403`. Caddy binds `13.140.158.49` only so it does not clash with Tailscale on `:443`. After editing the repo file, copy it to `/etc/caddy/Caddyfile` (do not symlink under `/root` — the `caddy` user cannot read it) and `systemctl restart caddy`.

```sh
# Loopback (on the bot host) — evening-before HITL needs id (+ status)
curl -sS -X POST http://127.0.0.1:8080/webhooks/tomorrow-reminder \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -d '{"telegramId":"123456789","meetings":[{"id":"meetIdHere","name":"Консультація","dateStart":"2026-08-22T10:00:00","status":"Planned"}]}'

# From EspoCRM (91.99.109.18)
curl -sS -X POST https://fedchenko.slnnzmtl.xyz/webhooks/tomorrow-reminder \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -d '{"telegramId":"123456789","meetings":[{"id":"meetIdHere","name":"Консультація","dateStart":"2026-08-22T10:00:00","status":"Planned"}]}'
```

Body: `telegramId` (string or number) and `meetings` (at least one `{ name, dateStart }`; optional `id` / `meetingId` / `status`). Success: `{ "ok": true, "hitl": boolean }`. EspoCRM controls **when** the webhook fires (minutes before, evening before, etc.); the bot adapts the Ukrainian intro from each meeting’s `dateStart` vs Kyiv now («через N хв», «сьогодні», «завтра», or a generic line). `dateStart` may be Kyiv wall time without a zone, or ISO-8601 with `Z` / ±offset (converted to Europe/Kyiv for copy).

**Evening-before HITL:** when a meeting is Kyiv **tomorrow**, status is **Planned** (or omitted), and `id` (or `meetingId`) is present, the bot sends ✅/❌ and sets CRM status to `Confirmed` (✅) or `Not Held` (❌). Without `id`, response is still `{ "ok": true, "hitl": false }` (notify-only). «Головне меню» dismisses the confirm card without changing CRM. Already-`Confirmed` visits get a notify-only reminder (no keyboard). EspoCRM evening-before POSTs must include Meeting `id` and preferably `status`.

If CRM returns **409** «This meeting is outside working hours», status updates are blocked by a Meeting save hook whenever `dateStart` is outside the Working Time Calendar (here 11:00–15:00). Confirm/cancel cannot succeed for those visits until the hook skips **status-only** updates (or honors `X-Skip-Working-Hours-Check` from MCP) or the visit is moved into working hours.

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

- `src/graph/` — thin LangGraph (supervisor + faq/booking agent loops)
- `src/composition/` — runtime wiring, MCP adapters, build-time agents
- `src/analytics/` — Tier 1 booking-funnel events (`trackEvent` → LangSmith child runs)
- `src/tools/` — EspoCRM MCP LangChain tools, availability free/busy, telegram user context (ALS)
- `src/adapter/` — telegraf bot (`telegram-bot.ts`) + keyboard helpers (`telegram-ui.ts`)
- `src/prompts/` — supervisor / FAQ / booking prompts plus the shared `PATIENT_VOICE` block in `voice.ts` (source of truth with `src/composition/agents.ts`)
- `packages/llm-gemini` — Gemini connector + explicit context cache for supervisor routing (`GEMINI_CONTEXT_CACHE`, default on)

## FAQ / services

- Catalog questions (`list_services`): short categorized summary; **no prices** in the tool payload or reply
- Pricing: `get_service` for the matched service only; quote only what the user asked for
- USD → UAH: when CRM `priceCurrency` is USD, `get_service` fetches `usd.uah` from [currency-api](https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json) and attaches `priceUah`; FAQ quotes it only if the user asks in UAH (FX failure → native USD, no invented rates)

## Booking tools

Meeting tools (booking agent):

- `present_availability_slots` — free/busy from `search_meetings` and `CReservedTime`; optional `excludeMeetingIds` when rescheduling (current start is not listed)
- `create_meeting` — HITL Yes/No, then MCP `create_meeting`
- `list_planned_meetings` — upcoming Planned meetings for a Contact (`search_entity`)
- `cancel_meeting` — HITL Yes/No, then soft cancel (`update_meeting` status `Not Held`)
- `reschedule_meeting` — HITL Yes/No, then in-place `dateStart`/`dateEnd` update

## Telegram behaviour

- `/start` replies with a static intro and categorized services (no prices); working hours come from CRM `get_working_time`; the same text is appended to the chat's graph message history as an `AIMessage` so later agent turns see it. Both `/start` messages attach the **DEFAULT MENU** reply keyboard (no visits → «Записатись», «Послуги», «Адреса»; has a visit → «Мій запис», «Послуги», «Адреса»; plus «Головне меню»), using a Telegram contact + planned-meetings lookup.
- Private chats only (groups get a short redirect); 20 messages per user per minute (text, voice, `/start`, and reply-keyboard taps)
- `thread_id = chat.id`; per-chat exclusive graph invoke queue
- Conversation and HITL state live in process memory (`MemorySaver` plus a pending-confirm map). A restart clears chats; there is no long-term transcript store. Run a single bot instance.
- SIGINT/SIGTERM stop Telegram polling, wait for in-flight handler work, then abort in-flight EspoCRM MCP HTTP calls (`shutdownAdapters`). MCP `/health` is checked at process start; later MCP outages fail the tool call (30s timeout).
- Each turn runs under `runWithTelegramUserId(from.id)` (CRM `cTelegram`)
- Meeting writes (`create_meeting`, `cancel_meeting`, `reschedule_meeting`) and `list_planned_meetings` require the Contact/`meetingId` to belong to that Telegram user
- At most one Planned meeting per patient: `create_meeting` is blocked until the existing visit is cancelled or rescheduled
- Supervisor prefetches contact + planned meetings into checkpointed state; booking prepare reuses that snapshot until a successful CRM write dirties it or the snapshot is older than ~5 minutes.
- `present_availability_slots` uses `search_meetings` and `CReservedTime` free/busy; the agent offers dates then times via reply shortcuts (the user may still type a slot). Ukrainian date labels are precomputed in TS (`dayLabel` per day, `whenLabel` per planned meeting) so the model quotes them instead of formatting dates itself
- When the next step is a short choice, the agent may append a hidden `<reply_buttons>` trailer; the adapter strips it and shows a one-time Telegram **reply keyboard**. Tapping a label sends that text as a normal message. Every keyboard ends with **«Головне меню»** (adapter-appended, including HITL and turns with no other shortcuts). Idle/greeting **DEFAULT MENU**: no visits → «Записатись», «Послуги», «Адреса»; has a visit → «Мій запис», «Послуги», «Адреса». After «Мій запис» lists the visit and offers a change: «Перенести», «Скасувати», «Ні, дякую». Mid-booking uses date/time shortcuts (dates plus «Інша дата», then times). «Головне меню» routes to a short idle reply with DEFAULT MENU; during HITL it declines the write.
- Internal failures (routing, model call, step limit) reply with `PATIENT_FALLBACK_MESSAGE`; the raw error goes to the log only
- HITL confirm: meeting writes pause on a one-time **reply keyboard** with ✅ / ❌ (replaces any prior date/time shortcuts). The agent must call the write tool on the same turn as a clear book/cancel/move intent — never a prior chat «підтвердити?». Tapping ✅ / ❌ resumes with `Command({ confirmed })`. Other text while the card is pending goes into the interrupt as `userReply`; the tool returns `awaitingConfirmation` (nothing written). If the user affirmed, the model re-calls the same tool with `confirmationGiven: true`. The server honors that flag only when a HITL card was already shown on this thread for the same write arguments. Chat text never implicitly cancels.
- Voice notes up to 60 seconds: Telegraf downloads the OGG, Gemini 3.1 Flash Lite transcribes it (`AUDIO_MODEL` optional), then the same text graph path runs; empty, failed, or longer recordings get a short Ukrainian fallback and do not invoke the graph. Replies are always text.

## Manual E2E checklist

1. Known Telegram user: booking skips phone/name after `cTelegram` lookup
2. Incomplete CRM contact (missing firstName/lastName/phone): collect them at book time, then `update_contact` before confirm
3. Unknown user: asks phone/name, create/link writes `cTelegram`
4. FAQ: hours/services from CRM; catalog has no prices; UAH ask on a USD service uses `priceUah`
5. Pick a date shortcut, then a time shortcut (or type a slot time from the agent's text list)
6. Tap ✅ to book; ❌ cancels without CRM write. Typing after the card (e.g. `так`) is handled by the agent re-calling the tool with `confirmationGiven: true`. A second Planned visit is refused until the first is cancelled or rescheduled.
7. After ✅/❌, agent continues; the next outbound reply replaces the reply keyboard
8. Cancel: list upcoming visits → ✅ soft-cancels (`Not Held`)
9. Reschedule: pick a *different* slot (`excludeMeetingIds` frees the old block but does not list the current start) → ✅ updates times
10. No recursion-limit loops after clarifying questions
