# Current Local Status

Date: 2026-07-21

## Implemented Locally

- Role and workspace access policy.
- Memory storage policy for family, child learning, and teacher-private scopes.
- Confirmation policy for external and sensitive actions.
- Agent profile routing by role and intent.
- Safe memory context builder.
- Orchestrator AI payload assembly with model profile resolution.
- Telegram identity mapping, intent inference, and webhook response handler.
- HTTP Telegram webhook endpoint with injectable orchestrator runtime.
- Repository-backed Telegram runtime: user lookup, conversation history write, memory load, AI response, and assistant message persistence.
- Telegram update idempotency for repeated webhook deliveries.
- Telegram Bot API outbound sender for `sendMessage`.
- Telegram webhook secret header validation.
- In-memory repositories for users, memories, conversations, reminders, and jobs.
- Prisma/PostgreSQL repository adapter for users, memories, conversations, reminders, and jobs.
- Async production startup hook that can create Prisma repositories when `DATABASE_URL` is set.
- Worker job creation, dedupe protection, locked-job skipping, execution, completion, and failure persistence.
- Timeweb AI provider contract aligned with orchestrator payload, with legacy direct agent call support.
- Production dependency factory for Timeweb AI env vars, agent IDs, repositories, and Telegram sender.
- Budget guard for daily and monthly AI spend limits.
- Timeweb deployment documentation and Docker Compose deployment skeleton.
- Timeweb PostgreSQL 17 DBaaS cluster provisioned for the MVP.
- App Platform Docker Compose startup command that runs Prisma migrations inside Timeweb before the API starts.
- Timeweb App Platform backend app deployed from Git URL repository.
- Production deploy applied Prisma migration `20260720000000_init`.
- Public technical domain `/health` check returns 200 OK.
- Production CLI utilities for Telegram webhook registration, production health checks, and family Telegram user bootstrap.
- Idempotent PostgreSQL user bootstrap from `FAMILY_AI_BOOTSTRAP_USERS`, guarded by `FAMILY_AI_BOOTSTRAP_USERS_ALLOW_WRITE`.
- Docker healthcheck for `/health`.
- Prisma schema and initial migration artifact for users, conversations, memory, students, lessons, materials, reminders, jobs, usage, and audit logs.
- Local automated test suite: 104 passing tests.

## Not Implemented Yet

- Live PostgreSQL smoke write test from inside Timeweb runtime.
- Timeweb AI agent IDs/API key configuration in App Platform.
- Telegram bot token and webhook registration in App Platform.
- S3 bucket and object upload integration.
- Web cabinet for owner and teacher.
- Authentication UI.
- Background worker loop connected to PostgreSQL.
- Production budget usage accounting from real model calls.

## Timeweb Runtime

- PostgreSQL DBaaS: `4190345`, status `started`, PostgreSQL 17.
- App Platform: `225845`, status `active`, preset `2731`, Moscow `ru-3`.
- Technical domain: `https://griff35victorov-ai-fam-8853.twc1.net`.
- Git source: `griff35victorov/AI---fam`, branch `main`.
- Deployed app commit: `7b69252777a6b1293336c9e4bb1bcf582c540b23`.
- Current monthly infrastructure estimate: PostgreSQL 970 RUB/month + App Platform 510 RUB/month = 1480 RUB/month.
- Timeweb AI agents inventory: 0 existing agents.
- Timeweb S3 inventory: 5 available presets; Hot 10 GB is 79 RUB/month.

## Next Engineering Slice

1. Inventory existing Timeweb AI agents/models and configure agent IDs/API key.
2. Add real family Telegram user IDs and run guarded user bootstrap.
3. Create/configure Telegram bot token and webhook secret, then register webhook.
4. Create private S3 bucket after price confirmation and connect material/file upload.
5. Add teacher workspace API for students, materials, lessons, and lesson notes.
