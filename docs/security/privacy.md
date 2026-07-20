# Privacy and Security Notes

## Core Principle

The system must separate family assistance, child learning, and teacher/student data. Agents can use only the context required for the current task.

## Roles

- `owner`: administers household settings, billing, and infrastructure.
- `teacher`: manages teacher workspace, students, lessons, and teaching materials.
- `child`: accesses child study agents and personal learning history.
- `system`: internal scheduled jobs and memory curation.

## Sensitive Data

Sensitive data includes:

- student names and contacts;
- lesson notes linked to a student;
- child private learning notes;
- tokens, API keys, and credentials;
- payment and budget details;
- private family facts.

## Memory Policy

Store:

- stable preferences;
- recurring schedules;
- learning goals;
- known constraints;
- teacher style preferences;
- reusable lesson patterns;
- user-approved important facts.

Do not store automatically:

- one-off emotional messages;
- secrets or passwords;
- raw student personal data in general family memory;
- medical, legal, or financial sensitive details without explicit need;
- private child messages in parent-visible memory by default.

## Confirmation Required

Require explicit confirmation before:

- deleting data;
- sharing private data across roles;
- sending outbound messages;
- generating documents in the teacher's name;
- using high-cost model mode;
- exporting student data.

## Practical MVP Safeguards

- Encrypt secrets.
- Use role checks on every data read.
- Keep audit logs for sensitive actions.
- Separate teacher materials from student personal records.
- Add export/delete flows for personal data.
- Keep backups and document retention rules.

