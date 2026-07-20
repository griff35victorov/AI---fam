# Family AI Orchestrator Design

Date: 2026-07-20

## Goal

Build a local-first, Timeweb-deployable family AI orchestration platform with autonomous cloud operation after deployment.

## Approved Direction

The system is not a set of isolated prompts. It is a small application that owns memory, permissions, schedules, teacher data, and routing while using Timeweb AI services for model calls and knowledge retrieval.

## Architecture

The core is a Family Orchestrator service. It receives messages from Telegram or web UI, identifies the user and role, loads allowed context, chooses an agent profile, calls Timeweb AI, stores the interaction, and schedules follow-up actions when needed.

The app uses PostgreSQL for durable operational data and memory. S3-compatible storage keeps original files. Timeweb AI Agents and knowledge bases can be attached behind a provider interface, so the app stays portable and controllable.

## MVP Components

- API and Telegram webhook.
- Family identity and role model.
- Agent router with profile prompts.
- Conversation history.
- Curated long-term memory.
- Teacher workspace.
- Child study workspace.
- Scheduler and worker.
- Timeweb AI provider.
- Budget guard.
- Audit log.

## Non-Goals for MVP

- Full legal compliance automation.
- Direct purchasing.
- Engineering-grade construction approval.
- Voice calls.
- Fully automatic third-party email/calendar control.

## Implementation Strategy

Use a TypeScript monorepo-style app to keep server, worker, and shared domain logic close. Start with database schema and orchestration contracts, then add Telegram and AI provider integration. Web admin can start minimal and expand after core flows work.

