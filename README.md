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

This repository starts locally first. The target GitHub repository is expected to be:

`griff35victorov/family-ai-orchestrator`

The current GitHub connector can work with existing repositories but does not expose repository creation. Create an empty GitHub repository with that name, then the local repository can be pushed there.

## Documentation

- `docs/product/mvp-spec.md` - product and system specification.
- `docs/architecture/overview.md` - architecture overview.
- `docs/deployment/timeweb.md` - target Timeweb deployment model.
- `docs/security/privacy.md` - privacy and access boundaries.
- `docs/superpowers/plans/2026-07-20-family-ai-orchestrator-mvp.md` - implementation plan.

