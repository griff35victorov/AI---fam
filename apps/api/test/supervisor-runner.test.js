import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryRepositories } from "../../../packages/db/src/index.js";
import { runSupervisorTick } from "../src/supervisor-runner.js";

test("runSupervisorTick requeues stale Telegram updates only", async () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const repositories = createInMemoryRepositories({
    jobs: [
      {
        id: "telegram-stale",
        type: "telegram-update",
        payload: { update: { update_id: 1 } },
        status: "running",
        runAt: new Date("2026-07-22T11:50:00.000Z"),
        lockedUntil: new Date("2026-07-22T11:55:00.000Z"),
        result: { stage: "processing" },
      },
      {
        id: "reminder-stale",
        type: "send_reminder",
        payload: { reminderId: "reminder-1" },
        status: "running",
        runAt: new Date("2026-07-22T11:50:00.000Z"),
        lockedUntil: new Date("2026-07-22T11:55:00.000Z"),
        result: { stage: "processing" },
      },
    ],
  });
  const notifications = [];

  const result = await runSupervisorTick({
    repositories,
    now,
    notifier: async (text) => notifications.push(text),
  });

  assert.equal(result.autoHealedJobs, 1);
  assert.equal(result.report.metrics.staleRunningJobs, 1);
  assert.equal(notifications.length, 1);

  const jobs = await repositories.jobs.listRecent({ limit: 10 });
  assert.equal(jobs.find((job) => job.id === "telegram-stale").status, "queued");
  assert.equal(jobs.find((job) => job.id === "reminder-stale").status, "running");
});

test("runSupervisorTick does not write OK audit logs by default", async () => {
  const repositories = createInMemoryRepositories();

  const result = await runSupervisorTick({
    repositories,
    now: new Date("2026-07-22T12:00:00.000Z"),
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(await repositories.auditLogs.listRecent({ limit: 10 }), []);
});

test("runSupervisorTick writes audit log when it finds a problem", async () => {
  const repositories = createInMemoryRepositories({
    jobs: [
      {
        id: "failed-1",
        type: "telegram-update",
        payload: {},
        status: "failed",
        runAt: new Date("2026-07-22T11:50:00.000Z"),
        error: "AI failed",
      },
    ],
  });

  const result = await runSupervisorTick({
    repositories,
    now: new Date("2026-07-22T12:00:00.000Z"),
  });

  assert.equal(result.status, "critical");
  const logs = await repositories.auditLogs.listRecent({ limit: 10 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, "supervisor_tick");
  assert.equal(logs[0].metadata.status, "critical");
});

test("runSupervisorTick finds stale jobs outside the recent jobs window", async () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const freshJobs = Array.from({ length: 220 }, (_, index) => ({
    id: `fresh-${index}`,
    type: "send_reminder",
    payload: {},
    status: "completed",
    runAt: new Date("2026-07-22T11:00:00.000Z"),
    updatedAt: new Date(now.getTime() - index * 1000),
  }));
  const repositories = createInMemoryRepositories({
    jobs: [
      ...freshJobs,
      {
        id: "old-stale-telegram",
        type: "telegram-update",
        payload: { update: { update_id: 1 } },
        status: "running",
        runAt: new Date("2026-07-22T10:00:00.000Z"),
        lockedUntil: new Date("2026-07-22T10:01:00.000Z"),
        updatedAt: new Date("2026-07-22T10:01:00.000Z"),
        result: { stage: "processing" },
      },
    ],
  });

  const result = await runSupervisorTick({
    repositories,
    now,
    jobLimit: 200,
  });
  const jobs = await repositories.jobs.listRecent({
    type: "telegram-update",
    limit: 1,
  });

  assert.equal(result.autoHealedJobs, 1);
  assert.equal(jobs[0].status, "queued");
});

test("runSupervisorTick deduplicates repeated audit logs for the same finding", async () => {
  const repositories = createInMemoryRepositories({
    jobs: [
      {
        id: "failed-1",
        type: "telegram-update",
        payload: {},
        status: "failed",
        runAt: new Date("2026-07-22T11:50:00.000Z"),
        error: "AI failed",
      },
    ],
  });

  await runSupervisorTick({
    repositories,
    now: new Date("2026-07-22T12:00:00.000Z"),
  });
  await runSupervisorTick({
    repositories,
    now: new Date("2026-07-22T12:01:00.000Z"),
  });

  const logs = await repositories.auditLogs.listRecent({ limit: 10 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].metadata.findingCodes[0], "failed_jobs");
});

test("runSupervisorTick keeps audit logs for distinct failures with the same count", async () => {
  const repositories = createInMemoryRepositories({
    jobs: [
      {
        id: "failed-1",
        type: "telegram-update",
        payload: {},
        status: "failed",
        runAt: new Date("2026-07-22T11:50:00.000Z"),
        error: "AI failed",
      },
    ],
  });

  await runSupervisorTick({
    repositories,
    now: new Date("2026-07-22T12:00:00.000Z"),
  });
  await repositories.jobs.rescheduleJob(
    { id: "failed-1" },
    { status: "manually_requeued" },
    new Date("2026-07-22T12:05:00.000Z"),
    new Date("2026-07-22T12:01:00.000Z"),
  );
  await repositories.jobs.enqueue({
    id: "failed-2",
    type: "telegram-update",
    payload: {},
    status: "failed",
    runAt: new Date("2026-07-22T11:55:00.000Z"),
    error: "AI failed again",
  });
  await runSupervisorTick({
    repositories,
    now: new Date("2026-07-22T12:02:00.000Z"),
  });

  const logs = await repositories.auditLogs.listRecent({ limit: 10 });
  assert.equal(logs.length, 2);
  assert.notEqual(logs[0].metadata.fingerprint, logs[1].metadata.fingerprint);
});
