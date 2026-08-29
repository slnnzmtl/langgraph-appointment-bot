# Clinic appointment bot

Telegram AI for a cosmetic clinic. Patients chat in private Telegram; the bot answers clinic FAQ and books / moves / cancels visits in EspoCRM via MCP. Ukrainian-first; replies in the patient’s language.

This file is the map for changing the product. Patient-facing copy lives in prompts; setup/ops live in [README.md](README.md). Do not copy either here.

## Topology

```
Telegram (telegraf, long poll)  →  LangGraph clinic graph  →  EspoCRM MCP HTTP
                                         │
                         ┌───────────────┼───────────────┐
                         ▼               ▼               ▼
                    Supervisor      FAQ agent      Booking agent
                    (route /         (read)         (read + write
                     FINISH)                         + HITL)
```

- **Interface:** private chats only; exclusive per-`thread_id` invoke queue; 20 messages/user/minute; optional `POST /webhooks/tomorrow-reminder`.
- **State:** in-process `MemorySaver` + pending HITL maps (restart clears chats; single instance). Checkpointed: contact + planned-meetings prefetch (~5 min TTL, dirty after a successful write), `availabilityContext` / `servicesContext`, `lastHandoff`, trimmed history (`MESSAGE_HISTORY_MAX_TOKENS`, default 6000).
- **Identity:** Telegram user id from Telegraf ALS (`runWithTelegramUserId`) → CRM `cTelegram`. Never from the model. Meeting writes and `list_planned_meetings` require ownership for that user. `assignedUserId` is injected server-side.
- **Models:** Gemini — chat/supervisor/agent default `gemini-2.5-flash-lite` (`GEMINI_MODEL` / `SUPERVISOR_MODEL` / `AGENT_MODEL`); voice `gemini-3.1-flash-lite` (`AUDIO_MODEL`). Context cache on by default (`GEMINI_CONTEXT_CACHE`).

## Where truth lives

| Change | Edit |
| --- | --- |
| Greeting, routing ladder, FINISH menus | `src/prompts/supervisor.ts` |
| Catalog / prices / location / yield tag | `src/prompts/faq.ts` |
| Booking ladder, HITL wording, slot UX | `src/prompts/booking.ts` |
| Shared patient voice + `<reply_buttons>` rules | `src/prompts/voice.ts` (imported into each prompt so it stays in the Gemini cache) |
| Sticky continue, FINISH button attach, prefetch | `src/graph/` (`supervisor.ts`, `agent-loop.ts`, `state.ts`) |
| CRM tools, HITL pause, free/busy, E.164 | `src/tools/` |
| Keyboards, `/start`, voice, rate limit, reminder | `src/adapter/` |
| Address, consultation id, menu label lists | `src/shared/clinic-constants.ts` |
| Wiring / agent defs (`maxSteps`) | `src/composition/` |

Do not add a third specialist, a second booking path, or a parallel keyboard format. One graph, one HITL confirm map, one reply-keyboard trailer.

## Agents

### Supervisor (router + greeter)

Only agent that greets. Each turn: `faq` / `booking` (empty `reply`; specialist sees full history) or `FINISH` (answer itself). No CRM tools.

- Prefetches contact + planned meetings into checkpointed state.
- On FINISH, the **server** attaches DEFAULT MENU or VISIT CHANGE. The model must not emit `<reply_buttons>`.
- `/start` stores `WELCOME_HISTORY_MARKER` in history, not the full welcome text (`src/adapter/welcome-message.ts`). Later hellos stay short.
- Key labels: «Записатись» → booking; «Послуги» / «Обрати іншу процедуру» / «Адреса» → faq; «Мій запис» → FINISH (list visits); «Перенести» / «Скасувати» → booking; «Головне меню» → FINISH greeting.

### Sticky routing

After an FAQ/booking handoff, tapping a shortcut the specialist just offered continues in that agent (skips the supervisor LLM). Supervisor-owned labels and free text still go through the LLM.

- FAQ book-handoff offers («Так» after consultation / book-this-procedure) append `<yield_to_supervisor/>` so the tap is re-routed to booking.
- Catalog drill-down taps stay in FAQ (no yield tag).
- «Перенести» / «Скасувати» sticky-route to booking even after a FINISH visit list.

### FAQ (read-only, `maxSteps` 4)

Tools: `list_services`, `get_service`, `get_working_time`. Reuse checkpointed `<list_services>` when present.

- Catalog: grouped summary, **no prices**; close with consultation offer («Так» / «Обрати іншу процедуру») + yield.
- After «Обрати іншу процедуру»: one catalog level per message (direction → family → zone → brand → book-this-procedure + yield).
- Prices: `get_service` for the matched service only; USD→UAH only via tool FX (`priceUah`), never invented.
- Address only when asked (`CLINIC_ADDRESS` + Maps constants).
- Skin concerns → offer consultation unless they already chose another procedure.

### Booking (read/write, `maxSteps` 10)

One ladder step per message: **service → time → details → optional intent note → book**, or **cancel/move**. Catalog browse is FAQ’s job. Booking may `list_services` once to match a typed CRM procedure name; it does not drill the catalog.

| Tool | Role |
| --- | --- |
| `list_services`, `get_service`, `get_working_time` | Same reads as FAQ |
| `present_availability_slots` | Free/busy (`search_meetings` + `CReservedTime`); date then time shortcuts; reuse `<availability>` when valid |
| `find_contact_by_phone`, `create_contact`, `link_telegram_to_contact`, `update_contact` | Patient identity |
| `list_planned_meetings` | Upcoming Planned visits |
| `create_meeting` / `cancel_meeting` / `reschedule_meeting` | Writes (HITL). Cancel → status `Not Held`. Reschedule uses `excludeMeetingIds` |

Rules:

- Default service is **Консультація** (`CONSULTATION_SERVICE_ID`) unless the patient is sure about a named procedure (or FAQ already chose one).
- At most **one Planned meeting**. Only Planned / Held / Confirmed block free/busy.
- Collect phone/name only after a slot is chosen; incomplete contacts get `update_contact` before confirm. Phones must be E.164.
- Book/move success includes address + Maps; cancel does not. Never put address in `confirmMessage`.
- Slots are Europe/Kyiv. Quote TS `dayLabel` / `whenLabel` / `visitLabel`; never invent dates.

## Writes, HITL, reminder

Create / cancel / reschedule pause on ✅/❌ (~15 min pending). Other text while pending returns `awaitingConfirmation` + `userReply` (nothing written). `confirmationGiven: true` is honored only if a matching confirm card was already shown. ❌ or «Головне меню» during confirm declines without a CRM write.

Voice notes ≤ 60s → Gemini transcription → same text graph. Longer / empty / failed → short Ukrainian fallback, no graph invoke.

Reminder webhook: requires `WEBHOOK_SECRET` (`X-Webhook-Secret`, timing-safe); Zod + body-size checks. EspoCRM POSTs `telegramId` + meetings. Time-aware Ukrainian copy from `dateStart` vs Kyiv now. HITL (Confirmed / Not Held) only for Planned + meeting `id`; pending lasts until visit start. Already-Confirmed or missing `id` → notify-only. Compose binds loopback; see README for Caddy.

Internal failures → `PATIENT_FALLBACK_MESSAGE`; details stay in logs. Graph recursion limit 40. MCP HTTP ~30s; SIGINT/SIGTERM stops polling and aborts in-flight MCP. LangSmith chat I/O redacted by default; Tier 1 analytics in `src/analytics/` (`ANALYTICS_DISABLED=1` skips those events only).

## Menus

Hidden `<reply_buttons>` trailers become one-time Telegram reply keyboards. Adapter always appends «Головне меню». English aliases (Book / Services / Address / …) are recognized for routing.

- **DEFAULT MENU:** no visit → «Записатись», «Послуги», «Адреса»; has visit → «Мій запис», «Послуги», «Адреса».
- **VISIT CHANGE:** «Перенести», «Скасувати», «Ні, дякую».
- Mid-flow: date labels + «Інша дата», then HH:mm; FAQ yes/no and catalog levels as needed.

## Code map

| Area | Path |
| --- | --- |
| Entrypoint | `src/index.ts` |
| Config | `src/config.ts` |
| Graph | `src/graph/` |
| Agent defs + wiring | `src/composition/` |
| Prompts | `src/prompts/` |
| EspoCRM tools | `src/tools/` |
| Telegram + welcome + reminder | `src/adapter/` |
| Shared helpers | `src/shared/` |
| Analytics | `src/analytics/` |
| Gemini package | `packages/llm-gemini` |

Verify with `pnpm check` and `pnpm test` (plus `pnpm test:all` if `packages/llm-gemini` changed). Setup, env, Docker, webhook, and E2E: [README.md](README.md).
