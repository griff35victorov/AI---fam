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
8. Let the `web` service run migrations before the API starts.
9. Open `/health`.
10. Configure Telegram webhook.
11. Send `/start` from an allowed Telegram account.

## Docker Compose Notes

The default deployment starts only `web` for the public API. Its startup command
runs Prisma migrations inside Timeweb before public traffic reaches the API.

`worker` and `scheduler` are assigned to the `background` Compose profile because
they are MVP placeholders. Enable `COMPOSE_PROFILES=background` only after their
long-running production loops are implemented.
