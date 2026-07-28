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

test("supervisor reports duplicate active Telegram update jobs", () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const report = analyzeSupervisorState({
    now,
    jobs: [
      {
        id: "telegram-duplicate-1",
        type: "telegram-update",
        status: "queued",
        payload: {
          botKey: "owner",
          update: { update_id: 900 },
        },
        runAt: new Date("2026-07-22T11:59:00.000Z"),
        dedupeKey: "legacy-key-1",
      },
      {
        id: "telegram-duplicate-2",
        type: "telegram-update",
        status: "running",
        payload: {
          botKey: "owner",
          update: { update_id: 900 },
        },
        runAt: new Date("2026-07-22T11:59:00.000Z"),
        lockedUntil: new Date("2026-07-22T12:05:00.000Z"),
        dedupeKey: "legacy-key-2",
      },
    ],
  });

  assert.equal(report.status, "warning");
  assert.equal(report.metrics.duplicateActiveJobs, 2);
  assert.deepEqual(
    report.findings.map((finding) => finding.code),
    ["duplicate_active_jobs"],
  );
});

test("supervisor reports Telegram delivery failures separately", () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const report = analyzeSupervisorState({
    now,
    jobs: [
      {
        id: "delivery-failed",
        type: "telegram-delivery",
        status: "failed",
        payload: {
          botKey: "owner",
          updateId: 900,
          chatId: 777,
        },
        result: { stage: "processing" },
        runAt: new Date("2026-07-22T11:59:00.000Z"),
      },
    ],
  });

  assert.equal(report.status, "critical");
  assert.equal(report.metrics.failedTelegramDeliveries, 1);
  assert.deepEqual(
    report.findings.map((finding) => finding.code),
    ["failed_jobs", "telegram_delivery_failed"],
  );
});

test("supervisor reports duplicate assistant replies and context loss", () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const report = analyzeSupervisorState({
    now,
    auditLogs: [
      {
        action: "assistant_quality_issue",
        createdAt: new Date("2026-07-22T11:59:00.000Z"),
        metadata: {
          issue: "duplicate_reply",
          count: 2,
        },
      },
      {
        action: "assistant_quality_issue",
        createdAt: new Date("2026-07-22T11:59:30.000Z"),
        metadata: {
          issue: "context_underfilled",
          recentMessagesFound: 0,
          memoriesFound: 0,
        },
      },
    ],
  });

  assert.equal(report.status, "warning");
  assert.equal(report.metrics.duplicateReplies, 1);
  assert.equal(report.metrics.contextUnderfilledResponses, 1);
  assert.deepEqual(
    report.findings.map((finding) => finding.code),
    ["duplicate_assistant_replies", "context_underfilled"],
  );
});

test("supervisor calculates slow AI latency distribution", () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const report = analyzeSupervisorState({
    now,
    auditLogs: [
      {
        action: "ai_response_slow",
        createdAt: new Date("2026-07-22T11:58:00.000Z"),
        metadata: { durationMs: 9000, modelProfile: "standard" },
      },
      {
        action: "ai_response_slow",
        createdAt: new Date("2026-07-22T11:59:00.000Z"),
        metadata: { durationMs: 18000, modelProfile: "standard" },
      },
    ],
  });

  assert.equal(report.metrics.slowAiResponses, 2);
  assert.equal(report.metrics.slowAiLatencyMs.max, 18000);
  assert.equal(report.metrics.slowAiLatencyMs.p95, 18000);
  assert.deepEqual(
    report.findings.map((finding) => finding.code),
    ["slow_ai_responses"],
  );
});
