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
- Worker job creation, dedupe protection, locked-job skipping, execution, completion, and failure persistence.
- Timeweb AI provider contract aligned with orchestrator payload, with legacy direct agent call support.
- Production dependency factory for Timeweb AI env vars, agent IDs, repositories, and Telegram sender.
- Budget guard for daily and monthly AI spend limits.
- Timeweb deployment documentation and Docker Compose skeleton.
- Prisma schema draft for users, conversations, memory, students, lessons, materials, reminders, jobs, usage, and audit logs.
- Local automated test suite: 63 passing tests.

## Not Implemented Yet

- Real PostgreSQL persistence and migrations.
- Real Telegram webhook registration script.
- Production startup wiring to real PostgreSQL repositories.
- Web cabinet for owner and teacher.
- File upload to S3.
- Authentication UI.
- Background worker loop connected to PostgreSQL.
- Production budget usage accounting from real model calls.

## Next Engineering Slice

1. Add PostgreSQL adapter and migrations after dependencies are installed.
2. Add Telegram webhook registration script and production smoke check.
3. Add teacher workspace API for students, materials, lessons, and lesson notes.
4. Add web cabinet for owner and teacher workflows.
5. Add production budget usage accounting from real model calls.
