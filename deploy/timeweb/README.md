# Timeweb MVP Deployment

## Target

Deploy the family AI orchestrator as a Timeweb App Platform Docker Compose application.

## Services

- `web`: public HTTP API, web admin, Telegram webhook.
- `worker`: AI jobs, reminders, reports, material processing.
- `scheduler`: creates due jobs from reminders and recurring schedules.

## External State

- PostgreSQL DBaaS is the source of truth.
- S3 stores files, exports, and generated assets.
- Timeweb AI provides model and agent calls.

## First Manual Setup

1. Create an empty GitHub repository: `griff35victorov/family-ai-orchestrator`.
2. Push this local project to `main`.
3. Create Timeweb PostgreSQL.
4. Create Timeweb S3 bucket.
5. Create Timeweb AI Agent/API key.
6. Create App Platform application from the GitHub repository.
7. Add environment variables from `env.production.example`.
8. Open `/health`.
9. Configure Telegram webhook.
10. Send `/start` from an allowed Telegram account.

