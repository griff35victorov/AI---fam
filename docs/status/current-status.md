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
- Worker job creation, dedupe protection, and locked-job skipping.
- Timeweb deployment documentation and Docker Compose skeleton.
- Prisma schema draft for users, conversations, memory, students, lessons, materials, reminders, jobs, usage, and audit logs.

## Not Implemented Yet

- Real PostgreSQL persistence and migrations.
- Real Telegram sendMessage/webhook registration.
- Real Timeweb AI request wiring in production runtime.
- Web cabinet for owner and teacher.
- File upload to S3.
- Authentication UI.
- Background worker loop connected to PostgreSQL.

## Next Engineering Slice

1. Add repository interfaces for conversations, memory, users, reminders, and jobs.
2. Add an in-memory adapter for local tests.
3. Add a PostgreSQL adapter after dependencies are installed.
4. Connect Telegram webhook to persisted users and conversations.
5. Connect Timeweb AI provider using production environment variables.
