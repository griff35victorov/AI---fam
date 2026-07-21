# Timeweb MVP Deployment

## Target

Deploy the family AI orchestrator as a Timeweb App Platform Docker Compose application.

## Current Deployment

- App Platform ID: `225845`.
- Technical domain: `https://griff35victorov-ai-fam-8853.twc1.net`.
- Source repository: `griff35victorov/AI---fam`, branch `main`.
- Runtime preset: `2731`, Moscow `ru-3`, 1 CPU, 1 GB RAM, 15 GB NVMe.
- PostgreSQL DBaaS ID: `4190345`.
- S3 bucket: `family-ai-prod-dq508761`, private Hot 10 GB.
- Timeweb AI: five private GPT 4.1 mini agents mapped to family roles through Agent API Access IDs.
- Last verified deploy: commit `94d9c4073d19808fcba027de1ebe4a13c25240c5`, `/health` returned 200 OK.

## Services

- `web`: public HTTP API, web admin, Telegram webhook.
- `worker`: AI jobs, reminders, reports, material processing.
- `scheduler`: creates due jobs from reminders and recurring schedules.

## External State

- PostgreSQL DBaaS is the source of truth.
- S3 stores files, exports, and generated assets.
- Timeweb AI provides model and agent calls.

## First Manual Setup

Completed:

- Git repository is connected from `griff35victorov/AI---fam`.
- PostgreSQL DBaaS is created.
- App Platform Docker Compose app is deployed.
- The `web` service applies Prisma migrations before the API starts.
- Private S3 bucket is created and wired in App Platform env.
- Timeweb AI agents are created and wired in App Platform env.
- `/health` returns 200 OK.

Remaining:

1. Add real `FAMILY_AI_BOOTSTRAP_USERS` records and set `FAMILY_AI_BOOTSTRAP_USERS_ALLOW_WRITE=1` for exactly one deploy.
2. Return `FAMILY_AI_BOOTSTRAP_USERS_ALLOW_WRITE=0` after users are created.
3. Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `APP_PUBLIC_URL`.
4. Run `npm run telegram:webhook:set`.
5. Send a test message from each allowed Telegram account.

Telegram access is controlled by `User.telegramUserId` records in PostgreSQL.
`TELEGRAM_ALLOWED_USER_IDS` is not used by the runtime.

Read-only inventory on 2026-07-21:

- Timeweb AI agents in the account: `5`, private, GPT 4.1 mini.
- Timeweb S3 presets available: Cold 1 GB pay-as-you-go, Hot 1 GB promo, Hot 10 GB, Hot 100 GB, Hot 250 GB pay-as-you-go.
- Selected S3 Hot preset for MVP materials: 10 GB, 79 RUB/month.

## Production Commands

- `npm run users:bootstrap` - upserts family Telegram users into PostgreSQL. Requires `FAMILY_AI_BOOTSTRAP_USERS_ALLOW_WRITE=1`.
- `npm run telegram:webhook:set` - registers `APP_PUBLIC_URL/telegram/webhook` in Telegram after validating the bot token.
- `npm run telegram:webhook:info` - reads Telegram webhook status.
- `npm run telegram:webhook:delete` - removes Telegram webhook.
- `npm run production:health` - checks `APP_PUBLIC_URL/health`.

## Docker Compose Notes

The default deployment starts only `web` for the public API. Its startup command
runs Prisma migrations inside Timeweb before public traffic reaches the API.

`worker` and `scheduler` are assigned to the `background` Compose profile because
they are MVP placeholders. Enable `COMPOSE_PROFILES=background` only after their
long-running production loops are implemented.
