# Help assistant (public chat bot)

Owner decisions 5-5e of `2026-11-26-landing-vs-zoom.md`. Code: `apps/api/src/assistant/`, `apps/web/src/help/`,
FAQ and guides: `packages/help-content/faq.json` (one file for the `/help` page and the bot), migration `017_help_assistant.sql`.

## What it does

- Where: a floating "Ask the assistant" button on the landing page, `/help`, the sign-in screen and the home screen.
  Never in the call (the pre-join screen only links to `/help#guide-devices`).
- Order of an answer: (1) while the person types, matching FAQ entries are offered in the window and answered locally;
  (2) a sent question is matched against the FAQ on the server in all three languages; (3) only when nothing matches
  well, a language model answers if one is configured, allowed for this caller and today's caps are not reached;
  (4) otherwise a fixed reply with the closest FAQ topics.
- No tools, no account/meeting/organisation data: the model sees only the FAQ (system prompt) and the last 8 masked
  turns of the conversation. Off-topic questions get a fixed refusal (the model is told to answer `OFF_TOPIC`).
- Limits: per address 6 questions per minute and 40 per day (`ASSISTANT_IP_PER_MINUTE`, `ASSISTANT_IP_PER_DAY`),
  500 characters per question (`ASSISTANT_MAX_CHARS`), 700 output tokens (`ASSISTANT_MAX_OUTPUT_TOKENS`).

## Language model adapters

| `ASSISTANT_LLM` | Where | Who gets model answers | Notes |
|---|---|---|---|
| `none` (default without a key) | anywhere | nobody: FAQ mode | the production state until the owner adds the key |
| `anthropic` (default with `ANTHROPIC_API_KEY`) | production | everyone, within the caps | official Claude API, model `ASSISTANT_MODEL` (default `claude-haiku-5-5`), prompt caching on the FAQ, effort `low` |
| `claude-cli` | STAGING only (`DAVRA_ENV=staging`) | the platform owner only (verified bearer token) | the owner's own `claude -p`, every tool, MCP server, slash command and setting source off. Refused at start when `DAVRA_ENV=production` |

Anthropic's Agent SDK terms do not allow offering claude.ai subscription login or limits in a product, hence the API on
production and the CLI only for the owner's own tests. The `pro` account is never used.

## Spend control

- Monthly: the owner sets a $20 spend limit for the API key's workspace in the Anthropic console.
- Daily, in the app: `ASSISTANT_DAILY_USD_CAP` (default $0.60) and `ASSISTANT_DAILY_LLM_REQUESTS` (default 400). The cost
  is computed from the token usage of every call with `ASSISTANT_PRICE_IN_PER_MTOK` / `ASSISTANT_PRICE_OUT_PER_MTOK`
  (defaults: Claude Haiku 5.5 list prices $0.10 / $0.50, checked 2026-11-26; re-check before launch). Above the cap the
  assistant answers in FAQ mode until the next UTC day.
- A provider error, timeout or exhausted credit never breaks the page: that question gets the FAQ-mode reply.

## Storage and privacy (decisions 5c/5d)

- Stored: the masked question and answer, answer source, language, page, time and a keyed hash of the address.
  E-mail addresses, phone-like and card-like numbers become `[email]`, `[phone]`, `[card]` before storing and before
  anything is sent to the model (our own `@davrabox.uz` mailboxes are kept).
- Kept 30 days after the last message (`ASSISTANT_RETENTION_DAYS`, 30 at most), deleted hourly by `assistant_purge`.
- Read only by the platform owner: admin console section "Assistant conversations", shown when the signed-in
  `org_admin`'s Keycloak subject id is listed in `PLATFORM_OWNER_SUBS`. Organisation administrators never see it; the
  application database role has no grant on the tables, only the SECURITY DEFINER functions of migration 017.
- The window states that conversations are stored and links `/privacy#legal-assistant`; `/privacy` has an
  "assistant" section and names Anthropic as a processor (only when the key is set).

## Operating it

Production `.env` (deploy/prod): `ANTHROPIC_API_KEY=` (empty = FAQ mode), `ASSISTANT_DAILY_USD_CAP=0.60`,
`PLATFORM_OWNER_SUBS=<keycloak user id of the owner>`. Restart the `api` service after a change.

Staging (PC, `scripts/devenv.sh` environment): `DAVRA_ENV=staging ASSISTANT_LLM=claude-cli PLATFORM_OWNER_SUBS=<id>`.
Keep staging owner-only while the CLI adapter is on.

API: `GET /v1/public/assistant/status`, `POST /v1/public/assistant/ask` (public); `GET /v1/platform/assistant/owner`,
`/usage`, `/conversations`, `/conversations/:id`, `DELETE /conversations/:id` (signed in; platform owner only except `owner`).
