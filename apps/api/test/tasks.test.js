import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryRepositories } from "../../../packages/db/src/index.js";
import { createLocalTasksProvider, parseReminderRequest } from "../src/tasks.js";

test("parseReminderRequest understands Russian tomorrow time", () => {
  const parsed = parseReminderRequest("Напомни завтра в 9 купить лампы", {
    now: new Date("2026-07-22T09:00:00.000Z"),
    timeZone: "Europe/Moscow",
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.title, "купить лампы");
  assert.equal(parsed.dueAt.toISOString(), "2026-07-23T06:00:00.000Z");
});

test("local tasks provider creates reminder and queues Telegram job", async () => {
  const repositories = createInMemoryRepositories();
  const provider = createLocalTasksProvider({
    remindersRepository: repositories.reminders,
    jobsRepository: repositories.jobs,
    now: () => new Date("2026-07-22T09:00:00.000Z"),
  });

  const result = await provider.createReminder({
    actor: { id: "owner-1" },
    workspaceId: "workspace-family",
    chatId: 777,
    botKey: "owner",
    text: "Напомни завтра в 9 купить лампы",
  });

  assert.equal(result.source, "tasks_reminders");
  assert.match(result.text, /Напоминание создано/);

  const upcoming = await repositories.reminders.listUpcoming({
    userId: "owner-1",
    workspaceId: "workspace-family",
    now: new Date("2026-07-22T09:00:00.000Z"),
  });
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].title, "купить лампы");

  const job = await repositories.jobs.claimNextJob(new Date("2026-07-23T06:00:00.000Z"));
  assert.equal(job.type, "send_reminder");
  assert.equal(job.payload.chatId, 777);
});
