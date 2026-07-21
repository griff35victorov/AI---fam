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
- Last verified deploy: commit `5ad8ca8be505ceb6ebbdc036faed8f93eab6c347`, `/health` returned 200 OK.

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
- Owner, daughter, and teacher Telegram bot tokens are stored in App Platform env.
- Dedicated Telegram webhook endpoints are deployed and protected by webhook secrets.
- Owner, daughter, and teacher users are bootstrapped into PostgreSQL.
- Owner, daughter, and teacher Telegram webhooks are registered.
- Telegram replies use webhook-response mode for the first visible answer because direct outbound `sendMessage` from Timeweb is not reliable in this runtime.
- Telegram `/start` uses a fast local webhook-response after user and bot-role authorization, which avoids Telegram webhook timeout on first bot start without bypassing access control.
- Normal Telegram messages use a fast visible webhook acknowledgement before AI routing. Background AI processing sends the final answer only through the configured Telegram relay, not through direct Timeweb -> Telegram `sendMessage`.
- Owner, daughter, and teacher webhooks are registered with the App Platform IP address and protected by dedicated Telegram webhook secrets.
- Owner, daughter, and teacher webhooks use `max_connections=1`.
- `/health` returns 200 OK.
- Telegram relay code is available in `apps/telegram-relay` for switching Telegram ingress away from the unstable direct Telegram -> Timeweb path while keeping Timeweb as the core runtime. The relay also exposes a protected send API for final AI answers.

Remaining:

1. Send a fresh test message from each allowed Telegram account in their dedicated bot after the `5ad8ca8` deploy.
2. Deploy `apps/telegram-relay` and register owner, daughter, and teacher Telegram webhooks to the relay URL.
3. Set `TELEGRAM_RELAY_URL`, `TELEGRAM_RELAY_SECRET`, and optionally `TELEGRAM_RELAY_UPSTREAM_SECRET` in Timeweb App Platform env, then redeploy.
4. Connect material/file upload to the private S3 bucket.
5. Add teacher workspace APIs and web cabinet.

Telegram access is controlled by `User.telegramUserId` records in PostgreSQL.
`TELEGRAM_ALLOWED_USER_IDS` is not used by the runtime.

Read-only inventory on 2026-07-21:

- Timeweb AI agents in the account: `5`, private, GPT 4.1 mini.
- Timeweb S3 presets available: Cold 1 GB pay-as-you-go, Hot 1 GB promo, Hot 10 GB, Hot 100 GB, Hot 250 GB pay-as-you-go.
- Selected S3 Hot preset for MVP materials: 10 GB, 79 RUB/month.

## Production Commands

- `npm run users:bootstrap` - upserts family Telegram users into PostgreSQL. Requires `FAMILY_AI_BOOTSTRAP_USERS_ALLOW_WRITE=1`.
- `npm run telegram:webhook:set` - registers `APP_PUBLIC_URL/telegram/webhook` in Telegram after validating the bot token.
- `npm run telegram:webhooks:set` - registers `owner`, `daughter`, and `teacher` dedicated bot webhooks.
- `npm run telegram:webhook:info` - reads Telegram webhook status.
- `npm run telegram:webhooks:info` - reads dedicated bot webhook statuses.
- `npm run telegram:webhook:delete` - removes Telegram webhook.
- `npm run telegram:webhooks:delete` - removes dedicated bot webhooks.
- `npm run production:health` - checks `APP_PUBLIC_URL/health`.
- `npm run test:relay` - checks the Telegram relay contract locally.

## Docker Compose Notes

The default deployment starts only `web` for the public API. Its startup command
runs Prisma migrations inside Timeweb before public traffic reaches the API.

`worker` and `scheduler` are assigned to the `background` Compose profile because
they are MVP placeholders. Enable `COMPOSE_PROFILES=background` only after their
long-running production loops are implemented.
