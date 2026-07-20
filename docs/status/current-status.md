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
- In-memory repositories for users, memories, conversations, reminders, and jobs.
- Worker job creation, dedupe protection, locked-job skipping, execution, completion, and failure persistence.
- Budget guard for daily and monthly AI spend limits.
- Timeweb deployment documentation and Docker Compose skeleton.
- Prisma schema draft for users, conversations, memory, students, lessons, materials, reminders, jobs, usage, and audit logs.
- Local automated test suite: 45 passing tests.

## Not Implemented Yet

- Real PostgreSQL persistence and migrations.
- Real Telegram sendMessage/webhook registration.
- Real Timeweb AI request wiring in production runtime.
- Web cabinet for owner and teacher.
- File upload to S3.
- Authentication UI.
- Background worker loop connected to PostgreSQL.
- Production budget usage accounting from real model calls.

## Next Engineering Slice

1. Connect Telegram webhook to persisted users, conversations, memory context, and AI responses.
2. Add PostgreSQL adapter and migrations after dependencies are installed.
3. Add Telegram Bot API outbound sender and webhook registration script.
4. Connect Timeweb AI provider using production environment variables.
5. Add teacher workspace API for students, materials, lessons, and lesson notes.
