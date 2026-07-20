# Current Local Status

Date: 2026-07-20

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
- Docker healthcheck for `/health`.
- Prisma schema and initial migration artifact for users, conversations, memory, students, lessons, materials, reminders, jobs, usage, and audit logs.
- Local automated test suite: 93 passing tests.

## Not Implemented Yet

- Live PostgreSQL smoke write test from inside Timeweb runtime.
- Timeweb AI agent IDs/API key configuration in App Platform.
- Telegram bot token and webhook registration in App Platform.
- S3 bucket and object upload integration.
- Real Telegram webhook registration script.
- Web cabinet for owner and teacher.
- Authentication UI.
- Background worker loop connected to PostgreSQL.
- Production budget usage accounting from real model calls.

## Timeweb Runtime

- PostgreSQL DBaaS: `4190345`, status `started`, PostgreSQL 17.
- App Platform: `225845`, status `active`, preset `2731`, Moscow `ru-3`.
- Technical domain: `https://griff35victorov-ai-fam-8853.twc1.net`.
- Git source: `griff35victorov/AI---fam`, branch `main`, commit `46333593387ae1186ccafd9d021a3f251d86f2bf`.
- Current monthly infrastructure estimate: PostgreSQL 970 RUB/month + App Platform 510 RUB/month = 1480 RUB/month.

## Next Engineering Slice

1. Configure Timeweb AI agent IDs and API key in App Platform.
2. Create/configure Telegram bot token and webhook secret.
3. Add Telegram webhook registration script and production smoke check.
4. Create S3 bucket and connect material/file upload.
5. Add teacher workspace API for students, materials, lessons, and lesson notes.
