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
- Dedicated owner, daughter, and teacher Telegram webhook routes with role-bound access checks.
- Telegram webhook CLI support for registering one bot or all three dedicated family bots.
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
- Private Timeweb S3 bucket created for production family materials.
- Five private Timeweb AI agents created and wired to owner, teacher, daughter, design, and scheduler profiles.
- Timeweb Agent API adapter verified against `agent.timeweb.cloud` OpenAI-compatible endpoint.
- App Platform env updated with S3 credentials, Agent API base URL, AI token, and agent Access ID mappings.
- Prisma schema and initial migration artifact for users, conversations, memory, students, lessons, materials, reminders, jobs, usage, and audit logs.
- Local automated test suite: 114 passing tests.

## Not Implemented Yet

- Live PostgreSQL smoke write test from inside Timeweb runtime.
- Real Telegram bot tokens and webhook registration in App Platform.
- Application-level S3 object upload workflow and teacher material ingestion.
- Web cabinet for owner and teacher.
- Authentication UI.
- Background worker loop connected to PostgreSQL.
- Production budget usage accounting from real model calls.

## Timeweb Runtime

- PostgreSQL DBaaS: `4190345`, status `started`, PostgreSQL 17.
- App Platform: `225845`, status `active`, preset `2731`, Moscow `ru-3`.
- Technical domain: `https://griff35victorov-ai-fam-8853.twc1.net`.
- Git source: `griff35victorov/AI---fam`, branch `main`.
- Deployed app commit: `94d9c4073d19808fcba027de1ebe4a13c25240c5`.
- Current monthly infrastructure estimate: PostgreSQL 970 RUB/month + App Platform 510 RUB/month + S3 Hot 10 GB 79 RUB/month + Timeweb AI agents/token package usage. Practical MVP estimate after agent creation is about 2060-2065 RUB/month before variable overage.
- Timeweb AI agents: 5 private active agents created on GPT 4.1 mini.
- Timeweb S3: private bucket `family-ai-prod-dq508761`, Hot 10 GB.

## Next Engineering Slice

1. Add real family Telegram user IDs and run guarded user bootstrap.
2. Add owner, daughter, and teacher bot tokens and webhook secrets to App Platform.
3. Register all three Telegram webhooks.
4. Connect material/file upload to the private S3 bucket.
5. Add teacher workspace API for students, materials, lessons, and lesson notes.
