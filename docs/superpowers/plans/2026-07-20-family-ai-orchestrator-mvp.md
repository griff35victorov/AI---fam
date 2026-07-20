# Family AI Orchestrator MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first cloud-ready MVP of the family AI orchestrator.

**Architecture:** A TypeScript backend owns identity, routing, memory, teacher data, scheduling, and provider calls. Timeweb AI is integrated through a provider interface so models and agents can be changed without rewriting business logic.

**Tech Stack:** TypeScript, Node.js, Fastify, Prisma, PostgreSQL, Telegram bot API, Docker Compose, Vitest.

---

## File Structure

- `apps/api`: HTTP API and Telegram webhook.
- `apps/worker`: background jobs and schedules.
- `packages/domain`: shared domain types and policies.
- `packages/ai`: Timeweb AI provider abstraction.
- `packages/db`: Prisma schema and database client.
- `docs`: product, architecture, deployment, security docs.

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `apps/api/package.json`
- Create: `apps/worker/package.json`
- Create: `packages/domain/package.json`
- Create: `packages/ai/package.json`
- Create: `packages/db/package.json`

- [ ] Create workspace package files.
- [ ] Add TypeScript, lint, test scripts.
- [ ] Run package manager install.
- [ ] Commit scaffold.

## Task 2: Domain Model

**Files:**
- Create: `packages/domain/src/roles.ts`
- Create: `packages/domain/src/agent-profiles.ts`
- Create: `packages/domain/src/policies.ts`
- Create: `packages/domain/src/budget.ts`
- Create: `packages/domain/src/index.ts`
- Test: `packages/domain/src/*.test.ts`

- [ ] Write failing tests for role access boundaries.
- [ ] Write failing tests for confirmation-required actions.
- [ ] Implement minimal domain policies.
- [ ] Run tests.
- [ ] Commit domain model.

## Task 3: Database Schema

**Files:**
- Create: `packages/db/prisma/schema.prisma`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/index.ts`

- [ ] Add Prisma models for users, roles, conversations, messages, memories, students, lessons, materials, reminders, usage, audit logs.
- [ ] Generate Prisma client.
- [ ] Add migration.
- [ ] Commit database schema.

## Task 4: AI Provider Abstraction

**Files:**
- Create: `packages/ai/src/provider.ts`
- Create: `packages/ai/src/timeweb.ts`
- Create: `packages/ai/src/model-profiles.ts`
- Test: `packages/ai/src/*.test.ts`

- [ ] Write failing tests for model profile resolution.
- [ ] Write failing tests for budget metadata capture.
- [ ] Implement provider interface and Timeweb adapter skeleton.
- [ ] Commit AI package.

## Task 5: Orchestrator Core

**Files:**
- Create: `apps/api/src/orchestrator/router.ts`
- Create: `apps/api/src/orchestrator/context.ts`
- Create: `apps/api/src/orchestrator/respond.ts`
- Test: `apps/api/src/orchestrator/*.test.ts`

- [ ] Write failing tests for routing owner, child, and teacher messages.
- [ ] Implement route selection.
- [ ] Add context loading contract.
- [ ] Add response persistence contract.
- [ ] Commit orchestrator core.

## Task 6: Telegram Entry

**Files:**
- Create: `apps/api/src/telegram/webhook.ts`
- Create: `apps/api/src/telegram/identity.ts`
- Test: `apps/api/src/telegram/*.test.ts`

- [ ] Write failing tests for Telegram user mapping.
- [ ] Implement webhook handler.
- [ ] Connect handler to orchestrator.
- [ ] Commit Telegram entry.

## Task 7: Worker and Scheduling

**Files:**
- Create: `apps/worker/src/jobs.ts`
- Create: `apps/worker/src/reminders.ts`
- Create: `apps/worker/src/reports.ts`
- Test: `apps/worker/src/*.test.ts`

- [ ] Write failing tests for due reminder selection.
- [ ] Implement reminder execution skeleton.
- [ ] Add weekly report job skeleton.
- [ ] Commit worker.

## Task 8: Local Runtime

**Files:**
- Create: `docker-compose.yml`
- Create: `apps/api/src/server.ts`
- Create: `apps/worker/src/main.ts`

- [ ] Add local PostgreSQL service.
- [ ] Add API health endpoint.
- [ ] Add worker startup.
- [ ] Verify local services start.
- [ ] Commit local runtime.

## Task 9: Timeweb Deployment Assets

**Files:**
- Create: `deploy/timeweb/README.md`
- Create: `deploy/timeweb/env.production.example`
- Create: `deploy/timeweb/deploy-checklist.md`

- [ ] Document Timeweb app/server setup.
- [ ] Document PostgreSQL, S3, env vars, migrations, webhooks.
- [ ] Commit deployment docs.

## Task 10: MVP Smoke Tests

**Files:**
- Create: `tests/smoke/orchestrator-smoke.test.ts`

- [ ] Test an owner household request.
- [ ] Test a daughter study request.
- [ ] Test a teacher lesson request.
- [ ] Test a reminder due event.
- [ ] Run all tests.
- [ ] Commit smoke tests.

