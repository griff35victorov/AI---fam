# Family AI Orchestrator MVP Specification

Date: 2026-07-20

## Objective

Create a family AI orchestration system that is developed locally and then deployed to Timeweb Cloud so it can run autonomously without a local computer.

## Users

### Owner

Needs help with household tasks, technical questions, calculations, product search, drawings, gazebo design, calendar, reminders, and daily assistance.

### Daughter

Needs help with school learning, EGE preparation, English learning, homework support, and basic household tasks.

### Wife / Teacher

Needs a full assistant and secretary for offline and online English teaching: materials, lesson plans, students, scheduling, homework, reports, and a searchable library of teaching style and past work.

## MVP Scope

### Included

- User profiles and roles.
- Telegram bot entry point.
- Web admin for core data.
- Agent routing by user, intent, and task type.
- Persistent conversation history.
- Curated long-term memory.
- Teacher student database.
- Materials upload metadata and later S3 storage.
- Basic calendar/reminder model.
- Background jobs for scheduled reminders and weekly summaries.
- Timeweb AI provider abstraction.
- Cost limits per user and per day.

### Deferred

- Real payment or purchase automation.
- Direct access to external school systems.
- Full CAD-grade engineering calculations.
- Automatic email/calendar sync until accounts are connected.
- Full 152-FZ legal package beyond practical MVP safeguards.
- Voice calls and speech assessment.

## Agent Profiles

### Family Dispatcher

Routes every request to the right specialist profile. It must check role, permissions, budget, and whether the action requires confirmation.

### Owner Assistant

Handles household tasks, technical Q&A, calculations, product search briefs, and everyday planning.

### Design Assistant

Creates concepts, layouts, material lists, prompts for image generation, and preliminary drawings. It must mark structural calculations as requiring expert validation.

### Daughter Tutor

Explains school topics, helps prepare for EGE, checks reasoning, and avoids simply solving homework without explanation.

### Daughter English Coach

Runs English practice, grammar explanations, vocabulary, writing review, and progress summaries.

### Teacher Secretary

Manages students, lessons, homework, reminders, and teacher work planning.

### Teacher Methodologist

Creates lesson plans, worksheets, exercises, tests, and adapts materials to the teacher's style.

### Memory Curator

Extracts stable facts from conversations and proposes or stores memory entries according to policy.

### Scheduler

Runs reminders, weekly reports, study repetitions, lesson preparation prompts, and follow-ups.

## Autonomy Requirements

After deployment, the system must run on Timeweb Cloud without the local computer:

- app server stays online;
- database persists memory and operational data;
- background worker runs schedules;
- Telegram webhooks receive messages;
- Timeweb AI APIs handle model calls;
- S3 stores files;
- logs and error notifications are available.

## Confirmation Rules

The system must ask for confirmation before:

- sending messages to third parties;
- deleting materials, students, memories, or tasks;
- changing schedules for another user;
- using expensive model mode;
- generating external-facing documents in the teacher's name;
- making purchases or commitments.

## Success Criteria

- A family member can write in Telegram and receive a routed AI answer.
- The answer uses role-specific context and does not leak another user's private data.
- Important facts can be stored in memory and reused later.
- The wife can store students, lessons, materials, and generate lesson support.
- Scheduled reminders and reports run automatically.
- The system can be deployed to Timeweb with documented environment variables.

