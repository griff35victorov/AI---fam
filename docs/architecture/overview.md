# Architecture Overview

## High-Level Flow

```text
Telegram / Web UI
        |
        v
API Gateway and Auth
        |
        v
Family Orchestrator
        |
        +--> Policy and Budget Guard
        +--> Memory Retrieval
        +--> Agent Router
        +--> Tool Router
        |
        v
Timeweb AI / Knowledge Bases / External Tools
        |
        v
Response, Action, Memory Update, Audit Log
```

## Core Services

### Web App

Provides API endpoints, web admin, auth, and the main orchestration runtime.

### Worker

Runs scheduled tasks, reminders, weekly reports, material processing, and retryable jobs.

### PostgreSQL

Stores users, roles, conversations, messages, memories, students, lessons, tasks, budgets, and audit logs.

### Object Storage

Stores original teacher materials, generated files, images, and exports.

### Timeweb AI Provider

Abstracts Timeweb model calls and later Timeweb AI Agents / Knowledge Base calls.

## Main Modules

- `identity`: users, roles, households, permissions.
- `orchestrator`: request classification, routing, response assembly.
- `agents`: agent profiles, prompts, tool policies.
- `memory`: short-term history and long-term curated memory.
- `teacher`: students, lessons, homework, materials.
- `study`: daughter learning plans, EGE, English progress.
- `scheduler`: reminders, jobs, reports.
- `providers`: Timeweb AI, S3, Telegram.
- `billing`: token usage, daily and monthly limits.
- `audit`: action logs and sensitive data events.

## Data Boundaries

The wife teacher workspace is separated from general family memory. Student data is visible only to the teacher and owner-admin unless explicitly shared.

Child learning memory is separated from parent household tasks. Parent-level summaries can be generated, but raw private conversations should not be broadly exposed by default.

## MVP Technology Choice

Recommended MVP stack:

- TypeScript.
- Node.js.
- Fastify or NestJS for backend API.
- PostgreSQL with Prisma.
- Postgres-backed jobs first; Redis/BullMQ later if needed.
- Telegram bot framework.
- React/Next.js or simple server-rendered admin UI.
- Docker Compose for local development.

