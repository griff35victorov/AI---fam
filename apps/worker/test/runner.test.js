import assert from "node:assert/strict";
import test from "node:test";

import { executeJob, runWorkerTick } from "../src/runner.js";

test("executeJob calls handler by job type and returns completed result", async () => {
  const job = {
    id: "job-1",
    type: "send_reminder",
    payload: { reminderId: "reminder-1" },
    attempts: 0,
  };

  const result = await executeJob(job, {
    send_reminder: async (payload, receivedJob) => {
      assert.deepEqual(payload, { reminderId: "reminder-1" });
      assert.equal(receivedJob, job);
      return { sent: true };
    },
  });

  assert.deepEqual(result, {
    status: "completed",
    jobId: "job-1",
    type: "send_reminder",
    output: { sent: true },
    attempts: 0,
  });
});

test("executeJob returns failed result and increments attempts when handler throws", async () => {
  const result = await executeJob(
    {
      id: "job-1",
      type: "send_reminder",
      payload: { reminderId: "reminder-1" },
      attempts: 2,
    },
    {
      send_reminder: async () => {
        throw new Error("provider timeout");
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.jobId, "job-1");
  assert.equal(result.type, "send_reminder");
  assert.equal(result.error, "provider timeout");
  assert.equal(result.attempts, 3);
});

test("executeJob fails unknown job type with clear error", async () => {
  const result = await executeJob(
    { id: "job-1", type: "missing_handler", payload: {}, attempts: 0 },
    {},
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error, "Unknown job type: missing_handler");
  assert.equal(result.attempts, 1);
});

test("runWorkerTick claims one job, executes it, and persists completion", async () => {
  const now = new Date("2026-07-20T10:00:00.000Z");
  const calls = [];
  const job = {
    id: "job-1",
    type: "send_reminder",
    payload: { reminderId: "reminder-1" },
    attempts: 0,
  };
  const store = {
    async claimNextJob(receivedNow) {
      calls.push(["claimNextJob", receivedNow]);
      return job;
    },
    async completeJob(receivedJob, result, receivedNow) {
      calls.push(["completeJob", receivedJob, result, receivedNow]);
    },
    async failJob() {
      throw new Error("should not fail completed jobs");
    },
  };

  const result = await runWorkerTick(
    store,
    { send_reminder: async () => ({ sent: true }) },
    now,
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(calls, [
    ["claimNextJob", now],
    ["completeJob", job, result, now],
  ]);
});

test("runWorkerTick persists failure", async () => {
  const now = new Date("2026-07-20T10:00:00.000Z");
  const calls = [];
  const job = {
    id: "job-1",
    type: "send_reminder",
    payload: { reminderId: "reminder-1" },
    attempts: 0,
  };
  const store = {
    async claimNextJob() {
      return job;
    },
    async completeJob() {
      throw new Error("should not complete failed jobs");
    },
    async failJob(receivedJob, result, receivedNow) {
      calls.push(["failJob", receivedJob, result, receivedNow]);
    },
  };

  const result = await runWorkerTick(
    store,
    {
      send_reminder: async () => {
        throw new Error("provider timeout");
      },
    },
    now,
  );

  assert.equal(result.status, "failed");
  assert.equal(result.attempts, 1);
  assert.deepEqual(calls, [["failJob", job, result, now]]);
});

test("runWorkerTick returns idle when no job is available", async () => {
  const now = new Date("2026-07-20T10:00:00.000Z");
  const store = {
    async claimNextJob() {
      return null;
    },
    async completeJob() {
      throw new Error("should not complete without a job");
    },
    async failJob() {
      throw new Error("should not fail without a job");
    },
  };

  const result = await runWorkerTick(store, {}, now);

  assert.deepEqual(result, { status: "idle" });
});
