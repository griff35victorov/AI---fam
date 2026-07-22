import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeSupervisorState,
  staleJobsForSupervisorRequeue,
} from "../src/index.js";

test("supervisor reports Telegram backlog and failed jobs", () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const report = analyzeSupervisorState({
    now,
    jobs: [
      {
        id: "telegram-1",
        type: "telegram-update",
        status: "queued",
        runAt: new Date("2026-07-22T11:59:00.000Z"),
      },
      {
        id: "telegram-2",
        type: "telegram-update",
        status: "queued",
        runAt: new Date("2026-07-22T11:59:00.000Z"),
      },
      {
        id: "telegram-3",
        type: "telegram-update",
        status: "queued",
        runAt: new Date("2026-07-22T11:59:00.000Z"),
      },
      {
        id: "telegram-4",
        type: "telegram-update",
        status: "queued",
        runAt: new Date("2026-07-22T11:59:00.000Z"),
      },
      {
        id: "failed-1",
        type: "telegram-update",
        status: "failed",
        runAt: new Date("2026-07-22T11:58:00.000Z"),
      },
    ],
  });

  assert.equal(report.status, "critical");
  assert.equal(report.metrics.dueTelegramUpdates, 4);
  assert.equal(report.metrics.failedJobs, 1);
  assert.deepEqual(
    report.findings.map((finding) => finding.code),
    ["telegram_queue_backlog", "failed_jobs"],
  );
});

test("supervisor auto-heal list only includes Telegram update jobs", () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const jobs = [
    {
      id: "telegram-stale",
      type: "telegram-update",
      status: "running",
      runAt: new Date("2026-07-22T11:50:00.000Z"),
      lockedUntil: new Date("2026-07-22T11:55:00.000Z"),
      result: { stage: "processing" },
    },
    {
      id: "reminder-stale",
      type: "send_reminder",
      status: "running",
      runAt: new Date("2026-07-22T11:50:00.000Z"),
      lockedUntil: new Date("2026-07-22T11:55:00.000Z"),
      result: { stage: "processing" },
    },
  ];

  assert.deepEqual(
    staleJobsForSupervisorRequeue(jobs, now).map((job) => job.id),
    ["telegram-stale"],
  );
});

test("supervisor treats running jobs without lock as stale", () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const report = analyzeSupervisorState({
    now,
    jobs: [
      {
        id: "telegram-no-lock",
        type: "telegram-update",
        status: "running",
        runAt: new Date("2026-07-22T11:50:00.000Z"),
        lockedUntil: null,
        result: { stage: "processing" },
      },
    ],
  });

  assert.equal(report.metrics.staleRunningJobs, 1);
  assert.deepEqual(
    staleJobsForSupervisorRequeue([
      {
        id: "telegram-no-lock",
        type: "telegram-update",
        status: "running",
        runAt: new Date("2026-07-22T11:50:00.000Z"),
        lockedUntil: null,
        result: { stage: "processing" },
      },
    ], now).map((job) => job.id),
    ["telegram-no-lock"],
  );
});
