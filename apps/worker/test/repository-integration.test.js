import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryRepositories } from "../../../packages/db/src/index.js";
import { runWorkerTick } from "../src/runner.js";

test("runWorkerTick can use in-memory jobs repository directly", async () => {
  const repositories = createInMemoryRepositories({
    jobs: [
      {
        id: "job-1",
        type: "send_reminder",
        payload: { reminderId: "reminder-1" },
        status: "queued",
        runAt: new Date("2026-07-20T10:00:00.000Z"),
      },
    ],
  });

  const result = await runWorkerTick(
    repositories.jobs,
    { send_reminder: async () => ({ sent: true }) },
    new Date("2026-07-20T10:01:00.000Z"),
  );

  assert.equal(result.status, "completed");
  assert.equal(result.jobId, "job-1");

  const claimedAgain = await repositories.jobs.claimNextJob(
    new Date("2026-07-20T10:02:00.000Z"),
  );
  assert.equal(claimedAgain, null);
});
