# Timeweb Deployment Plan

## Target Runtime

The production system should run fully in Timeweb Cloud:

- application server;
- background worker;
- PostgreSQL database;
- S3-compatible object storage;
- Timeweb AI API / AI Agents;
- Telegram webhooks;
- backups and logs.

## Environment Variables

Required variables are listed in `.env.example`.

Production secrets must be stored in Timeweb environment settings or server secret files. They must not be committed.

## Deployment Shape

### MVP

Use Timeweb App Platform with Docker Compose. Keep application containers stateless and store all durable data in external services.

- `web`: HTTP API, Telegram webhook, web admin.
- `worker`: scheduled jobs, reminders, material processing.
- `scheduler`: creates due jobs from reminders and recurring tasks.

The first service in Docker Compose should be the public HTTP service because App Platform proxies it. Other services run as internal containers/processes.

### Recommended Production Split

- `web` service.
- `worker` service.
- managed PostgreSQL.
- S3 bucket.
- optional Redis when job volume grows.

## Background Tasks

MVP can use PostgreSQL job tables and a polling worker:

- reminders due now;
- weekly family summary;
- weekly teacher planning summary;
- daughter study repetition queue;
- memory review queue;
- material ingestion queue.

Redis/BullMQ can be introduced when throughput or reliability requires it.

## PostgreSQL Integration

The DB package contains a Prisma schema and an initial migration under `packages/db/prisma/migrations`. The runtime repository contract has both in-memory and Prisma-backed adapters; production startup can create Prisma-backed repositories when `DATABASE_URL` is set.

Before deploying against a live Timeweb database, install and generate Prisma client dependencies, then run the initial migration against the target PostgreSQL instance. The migration artifact uses Prisma's default quoted table and column names from `schema.prisma`.

For App Platform Docker Compose deployments, migrations are handled by the
one-off `migrate` service in `docker-compose.yml`. The public `web` service uses
`depends_on` with `service_completed_successfully` so it starts only after
`prisma migrate deploy` succeeds inside Timeweb.

### Prisma Commands

The root package exposes the live database workflow:

- `db:generate` - generates Prisma Client from `packages/db/prisma/schema.prisma`.
- `db:migrate` - runs `prisma migrate deploy` against the configured `DATABASE_URL`; use this for Timeweb and other live/shared PostgreSQL databases.
- `db:migrate:dev` - runs `prisma migrate dev` for local development databases only.
- `db:smoke` - runs `packages/db/src/smoke.js` against the configured `DATABASE_URL`.

Prisma CLI and Prisma Client are pinned in the root `package.json`, and `package-lock.json` locks the install graph for Docker builds. The Docker image uses `npm ci`, then generates Prisma Client, then prunes development dependencies.
Prisma CLI and Prisma Client are runtime dependencies because the Timeweb
deployment runs `prisma migrate deploy` inside the built image. The Docker image
uses `npm ci --omit=dev --ignore-scripts`, then generates Prisma Client.

`db:smoke` intentionally writes temporary rows to validate the repository-backed write path, then deletes its own smoke records. It refuses to run unless `FAMILY_AI_DB_SMOKE_ALLOW_WRITE=1` is set.

### Local PostgreSQL Smoke Flow

1. Start or provision a local PostgreSQL database.
2. Set `DATABASE_URL`, for example from `.env.example`.
3. Run `db:generate`.
4. Run `db:migrate:dev` for an isolated local database, or `db:migrate` when validating the production migration path against a disposable database.
5. Set `FAMILY_AI_DB_SMOKE_ALLOW_WRITE=1`.
6. Run `db:smoke`.

### Timeweb PostgreSQL Smoke Flow

1. Create or select the Timeweb PostgreSQL database.
2. Configure `DATABASE_URL` in the deployment environment or in a protected one-off migration shell.
3. Run `db:generate` during Docker build.
4. Let the `migrate` Compose service run `db:migrate` before the API starts.
5. Set `FAMILY_AI_DB_SMOKE_ALLOW_WRITE=1` only for the one-off smoke command.
6. Run `db:smoke` from the same network/runtime context that will run the app.

Do not run `db:migrate:dev` against Timeweb or any shared database because it is an interactive development command and may create or modify migration files.

## MVP Timeweb Services

- App Platform with Docker Compose.
- DBaaS PostgreSQL 17/18.
- Private S3-compatible bucket, endpoint `https://s3.twcstorage.ru`.
- Timeweb AI Agent and API key.
- Monitoring for `/health`.
- Optional private networking/firewall between app and DB when available.

Do not use Kubernetes for MVP. Do not store uploaded files inside containers.

For the first MVP deployment, `worker` and `scheduler` are behind the
`background` Compose profile because their current implementation is a
placeholder. Enable the profile after adding long-running production loops.

## Timeweb AI Integration

The app should not hardcode one model. It should use model profiles:

- `cheap`: routine routing, summaries, simple Q&A.
- `standard`: tutoring and teacher work.
- `strong`: complex design, technical analysis, high-value documents.
- `image`: image generation requests.

The orchestrator chooses a profile, and configuration maps profile to actual Timeweb model.

Production uses `TIMEWEB_AI_API_KEY`, `TIMEWEB_AI_BASE_URL`, and a profile-to-agent mapping. The mapping can be supplied as `TIMEWEB_AGENT_IDS` JSON or as individual variables such as `TIMEWEB_AGENT_OWNER_ASSISTANT`, `TIMEWEB_AGENT_TEACHER_METHODOLOGIST`, and `TIMEWEB_AGENT_DAUGHTER_TUTOR`.

## Telegram Integration

The public webhook endpoint is `POST /telegram/webhook`. In production the API runtime creates a Telegram sender from `TELEGRAM_BOT_TOKEN` and sends the final assistant text back through Bot API `sendMessage` after the local orchestrator finishes.

## Deployment Checklist

1. Create Timeweb server/app.
2. Create PostgreSQL.
3. Create S3 bucket.
4. Configure environment variables.
5. Connect GitHub repository to App Platform.
6. Run database migrations.
7. Configure Telegram webhooks.
8. Run smoke tests.
9. Enable backups.
10. Set AI cost limits.
