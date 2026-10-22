# Clinic appointment bot

Telegram AI for a cosmetic clinic. Patients chat in private Telegram; the bot answers clinic FAQ and books / moves / cancels visits in EspoCRM via MCP. Ukrainian-first; replies in the patient’s language.

This file is the map for changing the product. Patient-facing copy lives in prompts; setup/ops live in [README.md](README.md). Do not copy either here.

## Topology

```
Telegram  →  LangGraph clinic graph  →  EspoCRM MCP HTTP

Normal turn:
  prefetch → deterministic offered choice OR one structured interpretation
          → booking kernel | FAQ/catalog capability → effects → one grounded reply

Paused HITL resume:
  confirmation gate → correlated mutation result → booking kernel → grounded reply
  (does not re-enter ingress interpretation)
```

- **Interface:** private chats only; exclusive per-`thread_id` invoke queue; 20 messages/user/minute; optional `POST /webhooks/tomorrow-reminder`.
- **State:** file-backed SqliteSaver (`CHECKPOINT_DB_PATH`, default `data/checkpoints.sqlite`) keyed by Telegram `chat.id`; pending HITL chat-confirm + reminder maps stay in-process (single instance). Checkpointed: contact + planned-meetings prefetch (~5 min TTL, dirty after a successful write), `availabilityContext` / `servicesContext`, `lastHandoff`, `bookingDraft` (incl. `deferredTurn` / `bookingAttemptId`), trimmed history (`MESSAGE_HISTORY_MAX_TOKENS`, default 6000).
- **Identity:** Telegram user id from Telegraf ALS (`runWithTelegramUserId`) → CRM `cTelegram`. Never from the model. Meeting writes and `list_planned_meetings` require ownership for that user. `assignedUserId` is injected server-side.
- **Models:** Gemini — chat/supervisor/agent default `gemini-3.1-flash-lite` (`GEMINI_MODEL` / `SUPERVISOR_MODEL` / `AGENT_MODEL`); voice `gemini-3.1-flash-lite` (`AUDIO_MODEL`). Context cache on by default (`GEMINI_CONTEXT_CACHE`).

## Where truth lives

| Change | Edit |
| --- | --- |
| Ingress turn contract + routing | `src/graph/booking-domain/turn.ts`, `interpret.ts`, `receptionist-route.ts`, `supervisor/` |
| Booking decision kernel | `src/graph/booking-domain/decide.ts`, `booking-draft.ts` |
| Catalog / prices / location (FAQ capability) | `src/prompts/faq.ts`, `src/graph/faq-catalog.ts` |
| Card copy locale | `src/graph/booking-interaction-render.ts`, `booking__respond` |
| Shared patient voice sections | `src/prompts/voice.ts` |
| HITL resume identity | `src/graph/hitl-command-match.ts`, `src/composition/booking-hitl.ts` |
| CRM tools, HITL pause, free/busy, E.164 | `src/tools/` |
| Keyboards, `/start`, voice, rate limit, reminder | `src/adapter/` |
| Address, consultation id, menu label lists | `src/shared/clinic-constants.ts` |
| Wiring / agent defs (`maxSteps`) | `src/composition/` |

Do not add a third specialist, a second booking path, or a parallel keyboard format. One graph, one HITL confirm map, one keyboard format. Markup is owned by `pendingInteraction` (projection of the decision card) and rendered into `lastHandoff.replyButtons` for the adapter; `lastHandoff` is presentation/observability only.

## Agents

### Supervisor (ingress + greeter)

Two paths only:

1. **Normal turn:** prefetch → interpret once (deterministic offered labels first; structured LLM only if the patch is `{}`) → `routeUnderstoodTurn` → booking kernel | FAQ capability | FINISH. No pre-LLM sticky table and no supervisor routing LLM.
2. **Paused HITL resume:** confirmation gate → correlated mutation → booking kernel. Does **not** re-enter ingress interpretation.

- Prefetches contact + planned/confirmed meetings into checkpointed state.
- `lastHandoff` is presentation/observability only (reply text + buttons for Telegram) — never a routing authority.
- FINISH helpers attach DEFAULT MENU or VISIT CHANGE from intent + `bookingContext`, and the prefetch visit list on «Мій запис», hello, and «Головне меню». The adapter still appends «Головне меню». `/start` and reminders use `buildDefaultMenuKeyboard`.
- `/start` stores `WELCOME_HISTORY_MARKER` in history, not the full welcome text (`src/adapter/welcome-message.ts`). Later hellos stay short.
- Key labels (exact `labelIdFor`): «Записатись» → booking (`consultation`); named procedure with no visit → booking (`list_services` / catalog); «Послуги» → FAQ catalog browse (no `bookingDraft`); unique catalog CRM id → booking `catalog_service`; «Адреса» → FAQ; «Мій запис» → FINISH visit menu; «Перенести» / «Скасувати» → booking; «Головне меню» → FINISH greeting. Empty `{}`: greeting if idle, booking re-ask if a session is open.

### FAQ (read-only, `maxSteps` 4)

Tools: `list_services`, `get_service`, `get_working_time`. Reuse checkpointed `<list_services>` when present. FAQ **does not write `bookingDraft`** — idle browse uses `pendingInteraction` only (`service_candidate` owner faq); unique CRM id and REPLACE post-cancel catalog go through the booking kernel.

- Catalog: multi-id pages stay FAQ-owned chips. One remaining id hands off to booking with `catalog_service` (`accepted: false` confirm card in the kernel).
- After «Обрати іншу процедуру» (`choose_other`): FAQ root chips / `catalog_detour` without writing a draft.
- Prices / hours / address: FAQ **reads** only (`get_service` for the matched service; USD→UAH only via tool FX (`priceUah`); address from `CLINIC_ADDRESS` + Maps).
- Accidental `<yield_to_supervisor/>` tags are stripped from model text; they are **not** a routing signal.

### Booking (read/write, `maxSteps` 10)

One ladder step per message: **service → time → details → optional intent note → book**, or **cancel/move**. Catalog browse is FAQ’s job. At the open-note step, one typed turn interpreter emits events; the booking session reducer alone updates state. Service-change requests resolve only against a complete CRM catalog (no hardcoded service-name dictionaries). Booking reuses checkpointed `<list_services>` until slots exist, then omits the catalog from prompts (consultation id is in the prompt; named procedures may call `list_services` once at BOOK).

| Tool | Role |
| --- | --- |
| `list_services`, `get_service`, `get_working_time` | Same reads as FAQ |
| `present_availability_slots` | Free/busy (`search_meetings` + `CReservedTime`); date then time shortcuts; reuse `<availability>` when valid |
| `find_contact_by_phone`, `create_contact`, `link_telegram_to_contact`, `update_contact` | Patient identity |
| `list_planned_meetings` | Upcoming Planned or Confirmed visits (including off-hours doctor moves) |
| `create_meeting` / `cancel_meeting` / `reschedule_meeting` | Writes (HITL). Cancel → status `Not Held`. Reschedule uses `excludeMeetingIds` |

Rules:

- Default service is **Консультація** (`CONSULTATION_SERVICE_ID`) unless the patient is sure about a named procedure (or FAQ already chose one).
- At most **one Planned or Confirmed meeting**. Only Planned / Held / Confirmed block free/busy. A second booking is refused until the existing visit is **cancelled** (then the new slot can be booked). Reschedule is only offered when the patient explicitly asks about their visit («Мій запис»), not during a new-booking conflict. The bot cannot offer slots outside clinic hours, but it must still list a visit a doctor moved off-hours.
- Collect phone/name only after a slot is chosen; incomplete contacts get `update_contact` before confirm. Phones must be E.164.
- Book/move success includes service + Ukrainian when, address + Maps, and a «Мій запис» next-step line; cancel does not. Never put address in `confirmMessage`.
- Slots are Europe/Kyiv. Quote TS `dayLabel` / `whenLabel` / `visitLabel`; never invent dates.

## Writes, HITL, reminder

Create / cancel / reschedule open `mutation_confirm` in the same node that appends the mutation tool call (never on availability revalidation alone), then pause on ✅/❌ (~15 min pending). Composition `resumeConfirmBookingHitl` interprets against `mutation_confirm` and returns the reducer update; the adapter resumes with `Command`. Other text while pending returns `awaitingConfirmation` + `userReply` (nothing written). `confirmationGiven: true` is honored only if a matching confirm card was already shown. ❌ or «Головне меню» during confirm declines without a CRM write.

Voice notes ≤ 60s → Gemini transcription → same text graph. Longer / empty / failed → short Ukrainian fallback, no graph invoke.

Reminder webhook: requires `WEBHOOK_SECRET` (`X-Webhook-Secret`, timing-safe); Zod + body-size checks. EspoCRM POSTs `telegramId` + meetings to `http://appointment-bot:8080/webhooks/tomorrow-reminder` on the shared Docker network (port not published). Time-aware Ukrainian copy from `dateStart` vs Kyiv now. HITL (Confirmed / Not Held) only for Planned + meeting `id`; pending lasts until visit start. Already-Confirmed or missing `id` → notify-only.

Internal failures → `PATIENT_FALLBACK_MESSAGE`; details stay in logs. Graph recursion limit 40. MCP HTTP ~30s; SIGINT/SIGTERM stops polling, aborts in-flight MCP, and flushes tracing (bounded). Langfuse (when `LANGFUSE_TRACING=true`) keeps conversation text for self-hosted review while masking secrets/CRM/checkpoint dumps. Tier 1 analytics in `src/analytics/` (`ANALYTICS_DISABLED=1` skips those events only).

## Menus

The graph renders reply keyboards from `pendingInteraction` into `lastHandoff.replyButtons`. Models emit patient text only. Accidental `<reply_buttons>` / `<yield_to_supervisor/>` tags are stripped so they never reach Telegram. Adapter always appends «Головне меню». English aliases (Book / Services / Address / …) are recognized for inbound routing; keyboards the graph attaches are Ukrainian-only.

- **DEFAULT MENU** (code-owned): no visit → «Записатись», «Послуги», «Адреса»; has visit → «Мій запис», «Послуги», «Адреса». Supervisor `menu=default`, or **booking** finalize after a committed create/cancel/reschedule or HITL decline. Mid-flow free-text (phone, name) and FAQ with no open interaction: adapter shows only «Головне меню» (no DEFAULT MENU).
- **VISIT CHANGE** (`visit_select` stage `action` / `meeting`): «Перенести», «Скасувати», «Ні, дякую» — after «Мій запис» (unique labels when several meetings). Falls back to DEFAULT when the list is empty.
- **REPLACE** (`visit_select` stage `replacement`): «Скасувати», «Ні, дякую» — when `create_meeting` returned `Already booked`, or from the preemptive date gate when a visit already exists (never «Перенести» here). Kernel continues into `list_services` after cancel completes.
- **DATE / TIME** (`date_select` / `time_select` with availability render snapshot): short day labels + «Інша дата», then HH:mm — from `present_availability_slots` / `availabilityContext`.
- **BOOKING OFFER** (`service_confirm`): «Так», «Обрати іншу процедуру» — explicit CRM service id; owned by the booking kernel (not FAQ draft writes).
- **INTENT skip** (`visit_note`): «Продовжити без коментаря» (choice id `note_skip`). Free-text skip synonyms classify through the note-turn boundary.
- **Catalog drill-down** (FAQ-owned `service_candidate`): CRM-grounded choices with remaining `serviceIds`; not recovered from reply bullets.
- **CONTACT FIELD** (`contact_field`): phone/name waits emit a contact effect; clear only after a successful CRM result.
- **MUTATION CONFIRM** (`mutation_confirm`): opened only immediately before the mutation tool / interrupt.

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
