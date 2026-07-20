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

## MVP Timeweb Services

- App Platform with Docker Compose.
- DBaaS PostgreSQL 17/18.
- Private S3-compatible bucket, endpoint `https://s3.twcstorage.ru`.
- Timeweb AI Agent and API key.
- Monitoring for `/health`.
- Optional private networking/firewall between app and DB when available.

Do not use Kubernetes for MVP. Do not store uploaded files inside containers.

## Timeweb AI Integration

The app should not hardcode one model. It should use model profiles:

- `cheap`: routine routing, summaries, simple Q&A.
- `standard`: tutoring and teacher work.
- `strong`: complex design, technical analysis, high-value documents.
- `image`: image generation requests.

The orchestrator chooses a profile, and configuration maps profile to actual Timeweb model.

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
