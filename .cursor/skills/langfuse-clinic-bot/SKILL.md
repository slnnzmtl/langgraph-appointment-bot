---
name: langfuse-clinic-bot
description: >-
  Query the local self-hosted Langfuse (127.0.0.1:3001, OSS v4) for
  clinic-appointment-bot with langfuse-cli observations, not the v1 traces API.
  Use when the user asks about Langfuse, traces, last runs, clinic-turn,
  supervisor routing, Telegram chat debugging, or smoke traces.
---

# Langfuse CLI for clinic-appointment-bot

Read this skill before querying traces. Use `npx langfuse-cli`. Do not call Langfuse MCP. Do not use `GET /api/public/traces` (404 on this v4 host).

## Access

Host bind: `http://127.0.0.1:3001` (container `langfuse-web`, image pin in `/home/slnnzmtl/fedchenko/observability/langfuse`). Tailscale UI, if up: `https://langfuse.tail484f11.ts.net`.

Load keys from the bot env. Never print them, never write them into this skill, chat, or a plan.

```bash
set -a
source /home/slnnzmtl/fedchenko/agents/espocrm-appointment-bot/dev/.env
set +a
export LANGFUSE_HOST="${LANGFUSE_BASE_URL:-http://127.0.0.1:3001}"
```

The CLI reads `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY`. `LANGFUSE_BASE_URL` alone is not enough.

Reach localhost with unrestricted shell permissions (`required_permissions: ["all"]`). Isolated fetch cannot hit `127.0.0.1`.

Ready check:

```bash
curl -sS -m 5 "$LANGFUSE_HOST/api/public/ready"
```

Expect `{"status":"OK","version":"4.56.0"}` or a later 4.x on this host.

## Commands

Discover flags if a call 400s. Do not guess extra flags.

```bash
npx langfuse-cli api observations --help
npx langfuse-cli api observations list --help
```

List recent turns for one Telegram user (`userId` on the trace is the Telegram id; private chat `sessionId` matches it):

```bash
npx langfuse-cli api observations list --user-id 1363967211 --limit 30 --json
```

One trace (root id equals `traceId`):

```bash
npx langfuse-cli api observations list --trace-id <traceId> --limit 100 --json
```

Cursor pages: pass `meta.cursor` from the previous JSON into `--cursor`. Prefer `observations` over `legacy-observations-v1s`.

**Peek:** `http://127.0.0.1:3001/trace/<traceId>`

## What to read

Each Telegram or smoke message is one trace. LangGraph names the inner span `clinic-turn`. An outer `adapter` span is the ingest wrapper, not a second turn.

| Signal | Where |
| --- | --- |
| Patient text | trace input, or the last user message inside it |
| Visible reply | trace output. If output is a `messages` JSON blob, the patient-visible line is the last assistant message, not the whole blob |
| Route | event `supervisor_routing_decision`: `path`, `next`, `intent` |
| Graph | child span names: `faq__prepare`, `faq__llm`, `faq__finalize`, `booking__prepare`, `booking__llm`, `booking__tools` |
| Tags | `telegram` or `smoke` |

`faq__prepare` then `faq__finalize` with no `faq__llm` means prepare opened a menu and skipped the model. `faq__llm` on idle «запиши на …» means the model wrote the catalog.

Default operator ids, unless the user names another user or asks for all traffic: `1363967211` and `286834869`. Run one `--user-id` query each. Smoke uses `9998…` ids and tag `smoke`; do not mix those into operator queries.

## Reply

Lead with the route (`path` / `next` / `intent`) and the visible reply. Link the peek URL. Keep transcripts short. Do not paste API keys or raw `.env` lines.
