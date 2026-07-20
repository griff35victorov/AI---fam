import assert from "node:assert/strict";
import test from "node:test";

import { createDueReminderJobs, claimNextJob } from "../src/jobs.js";

test("scheduler creates jobs for due reminders only", () => {
  const reminders = [
    { id: "late", runAt: "2026-07-20T09:00:00.000Z", status: "scheduled" },
    { id: "future", runAt: "2026-07-20T11:00:00.000Z", status: "scheduled" },
    { id: "done", runAt: "2026-07-20T08:00:00.000Z", status: "sent" },
  ];

  const jobs = createDueReminderJobs(reminders, new Date("2026-07-20T10:00:00.000Z"));

  assert.deepEqual(jobs, [
    {
      type: "send_reminder",
      payload: { reminderId: "late" },
      dedupeKey: "send_reminder:late",
      runAt: "2026-07-20T09:00:00.000Z",
    },
  ]);
});

test("worker claims the oldest available queued job", () => {
  const jobs = [
    { id: "future", status: "queued", runAt: "2026-07-20T11:00:00.000Z" },
    { id: "oldest", status: "queued", runAt: "2026-07-20T08:00:00.000Z" },
    { id: "running", status: "running", runAt: "2026-07-20T07:00:00.000Z" },
  ];

  const claimed = claimNextJob(jobs, new Date("2026-07-20T10:00:00.000Z"));

  assert.equal(claimed.id, "oldest");
  assert.equal(claimed.status, "running");
});
