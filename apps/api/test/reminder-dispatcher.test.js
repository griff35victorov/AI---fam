import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryRepositories } from "../../../packages/db/src/index.js";
import { dispatchReminderJobsOnce } from "../src/reminder-dispatcher.js";

test("dispatchReminderJobsOnce sends due reminder Telegram job", async () => {
  const repositories = createInMemoryRepositories({
    reminders: [
      {
        id: "reminder-1",
        userId: "owner-1",
        workspaceId: "workspace-family",
        title: "купить лампы",
        runAt: new Date("2026-07-23T06:00:00.000Z"),
        status: "scheduled",
      },
    ],
    jobs: [
      {
        id: "job-1",
        type: "send_reminder",
        payload: {
          reminderId: "reminder-1",
          title: "купить лампы",
          chatId: 777,
          botKey: "owner",
        },
        status: "queued",
        runAt: new Date("2026-07-23T06:00:00.000Z"),
        attempts: 0,
      },
    ],
  });
  const sent = [];

  const result = await dispatchReminderJobsOnce({
    repositories,
    telegramSenders: {
      owner: {
        async sendMessage(message) {
          sent.push(message);
        },
      },
    },
    now: new Date("2026-07-23T06:00:00.000Z"),
  });

  assert.equal(result.processed, 1);
  assert.deepEqual(sent, [
    {
      chatId: 777,
      text: "Напоминание: купить лампы",
    },
  ]);
  assert.deepEqual(
    (await repositories.reminders.listDue(new Date("2026-07-23T06:01:00.000Z"))).map((reminder) => reminder.id),
    [],
  );
});

test("dispatchReminderJobsOnce does not resend reminder after send-stage delivery", async () => {
  const repositories = createInMemoryRepositories({
    reminders: [
      {
        id: "reminder-1",
        userId: "owner-1",
        workspaceId: "workspace-family",
        title: "buy lamps",
        runAt: new Date("2026-07-23T06:00:00.000Z"),
        status: "scheduled",
      },
    ],
    jobs: [
      {
        id: "reminder-job-1",
        type: "send_reminder",
        payload: {
          reminderId: "reminder-1",
          title: "buy lamps",
          chatId: 777,
          botKey: "owner",
        },
        status: "queued",
        runAt: new Date("2026-07-23T06:00:00.000Z"),
        attempts: 0,
      },
      {
        id: "delivery-job-1",
        type: "telegram-delivery",
        payload: { botKey: "owner", updateId: "reminder-1", chatId: 777 },
        status: "running",
        runAt: new Date("2026-07-23T06:00:00.000Z"),
        attempts: 1,
        lockedBy: "telegram-delivery",
        lockedUntil: new Date("2026-07-23T06:01:00.000Z"),
        dedupeKey: "telegram-reminder:owner:reminder-1:777",
        result: { stage: "send" },
      },
    ],
  });
  const sent = [];

  const result = await dispatchReminderJobsOnce({
    repositories,
    telegramSenders: {
      owner: {
        async sendMessage(message) {
          sent.push(message);
        },
      },
    },
    now: new Date("2026-07-23T06:10:00.000Z"),
  });

  assert.equal(result.processed, 1);
  assert.deepEqual(sent, []);
  assert.deepEqual(
    (await repositories.reminders.listDue(new Date("2026-07-23T06:11:00.000Z"))).map((reminder) => reminder.id),
    [],
  );
  const jobs = await repositories.jobs.listRecent({ type: "send_reminder", limit: 1 });
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].result.skipped, true);
});
