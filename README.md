# Family AI Orchestrator

Autonomous family AI orchestrator designed for local development and later deployment to Timeweb Cloud.

## Goal

Build a private family assistant system with:

- role-based assistants for owner, child, and teacher workflows;
- long-term memory and chat history;
- teacher materials library and student database;
- Telegram and web interfaces;
- scheduled reminders, reports, and learning tasks;
- Timeweb AI Agents / model API integration;
- deployment-ready infrastructure for Timeweb Cloud.

## First MVP

The first version focuses on a working cloud-ready core:

1. Family identity and role access.
2. Orchestrator that routes requests to specialized agent profiles.
3. Persistent chat history and curated long-term memory.
4. Teacher workspace: students, lessons, materials, lesson notes.
5. Child workspace: school/English study plan and progress notes.
6. Telegram entry point and basic web admin.
7. Background jobs for reminders and weekly reports.
8. Timeweb AI provider abstraction with cost limits.

## Repository Status

This repository is built locally and deployed to Timeweb Cloud from GitHub. Telegram traffic is routed through the relay gateway before it reaches the orchestrator.

## Telegram Operations

- `проверка связи` - fast health check for Telegram gateway, App Platform, and orchestrator.
- `диагностика` or `/diag` - shows recent latency, memory/material status, queue health, stale jobs, failed jobs, duplicates, and delivery signals.
- `/repair` - owner-only supervisor repair; safely requeues stale Telegram update jobs and failed Telegram update jobs that stopped before a final send attempt.

## Documentation

- `docs/product/mvp-spec.md` - product and system specification.
- `docs/architecture/overview.md` - architecture overview.
- `docs/deployment/timeweb.md` - target Timeweb deployment model.
- `docs/security/privacy.md` - privacy and access boundaries.
- `docs/status/current-status.md` - current local implementation status.
- `docs/superpowers/plans/2026-07-20-family-ai-orchestrator-mvp.md` - implementation plan.
