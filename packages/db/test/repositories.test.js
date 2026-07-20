import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createInMemoryRepositories } from "../src/index.js";

describe("in-memory repositories", () => {
  it("finds users by Telegram user id", async () => {
    const repositories = createInMemoryRepositories({
      users: [
        { id: "user-owner", displayName: "Owner", telegramUserId: "101" },
        { id: "user-teacher", displayName: "Teacher", telegramUserId: "202" },
      ],
    });

    assert.equal(
      (await repositories.users.findByTelegramUserId("202")).id,
      "user-teacher",
    );
    assert.equal(await repositories.users.findByTelegramUserId("missing"), null);
  });

  it("lists raw memories visible for an actor", async () => {
    const repositories = createInMemoryRepositories({
      memories: [
        {
          id: "memory-owner",
          workspaceId: "workspace-family",
          ownerUserId: "user-owner",
          scope: "family",
          sensitivity: "normal",
          subjectType: "preference",
          content: "Likes short reminders",
          createdAt: new Date("2026-07-20T09:00:00.000Z"),
        },
        {
          id: "memory-teacher",
          workspaceId: "workspace-teacher",
          ownerUserId: "user-teacher",
          scope: "teacher_private",
          sensitivity: "private",
          subjectType: "student",
          content: "Private note",
          createdAt: new Date("2026-07-20T10:00:00.000Z"),
        },
      ],
    });

    assert.deepEqual(
      (await repositories.memories.listForActor({
        actorUserId: "user-owner",
        workspaceId: "workspace-family",
      })).map((memory) => memory.id),
      ["memory-owner"],
    );
  });

  it("appends and lists conversation messages in creation order", async () => {
    const repositories = createInMemoryRepositories();

    await repositories.conversations.appendMessage("conversation-1", {
      role: "user",
      content: "Plan today",
      metadata: { source: "telegram" },
      createdAt: new Date("2026-07-20T09:00:00.000Z"),
    });
    await repositories.conversations.appendMessage("conversation-1", {
      role: "assistant",
      content: "Done",
      createdAt: new Date("2026-07-20T09:01:00.000Z"),
    });
    await repositories.conversations.appendMessage("conversation-2", {
      role: "user",
      content: "Other conversation",
    });

    assert.deepEqual(
      (await repositories.conversations.listMessages("conversation-1")).map(
        (message) => [message.role, message.content],
      ),
      [
        ["user", "Plan today"],
        ["assistant", "Done"],
      ],
    );
  });

  it("lists due scheduled reminders", async () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const repositories = createInMemoryRepositories({
      reminders: [
        {
          id: "due",
          userId: "user-owner",
          workspaceId: "workspace-family",
          title: "Due reminder",
          runAt: new Date("2026-07-20T11:59:00.000Z"),
          status: "scheduled",
        },
        {
          id: "future",
          userId: "user-owner",
          workspaceId: "workspace-family",
          title: "Future reminder",
          runAt: new Date("2026-07-20T12:01:00.000Z"),
          status: "scheduled",
        },
        {
          id: "done",
          userId: "user-owner",
          workspaceId: "workspace-family",
          title: "Done reminder",
          runAt: new Date("2026-07-20T11:58:00.000Z"),
          status: "sent",
        },
      ],
    });

    assert.deepEqual(
      (await repositories.reminders.listDue(now)).map((reminder) => reminder.id),
      ["due"],
    );
  });

  it("enqueues jobs with dedupe and claims unlocked due jobs", async () => {
    const repositories = createInMemoryRepositories();
    const runAt = new Date("2026-07-20T12:00:00.000Z");

    const first = await repositories.jobs.enqueue({
      type: "send-reminder",
      payload: { reminderId: "reminder-1" },
      runAt,
      dedupeKey: "reminder-1",
    });
    const second = await repositories.jobs.enqueue({
      type: "send-reminder",
      payload: { reminderId: "reminder-1" },
      runAt,
      dedupeKey: "reminder-1",
    });

    assert.equal(second.id, first.id);

    const claimed = await repositories.jobs.claim({
      workerId: "worker-1",
      now: new Date("2026-07-20T12:01:00.000Z"),
      lockMs: 60_000,
    });

    assert.equal(claimed.id, first.id);
    assert.equal(claimed.status, "running");
    assert.equal(claimed.attempts, 1);

    assert.equal(
      await repositories.jobs.claim({
        workerId: "worker-2",
        now: new Date("2026-07-20T12:01:01.000Z"),
        lockMs: 60_000,
      }),
      null,
    );

    const reclaimed = await repositories.jobs.claim({
      workerId: "worker-2",
      now: new Date("2026-07-20T12:02:01.000Z"),
      lockMs: 60_000,
    });

    assert.equal(reclaimed.id, first.id);
    assert.equal(reclaimed.lockedBy, "worker-2");
    assert.equal(reclaimed.attempts, 2);
  });
});
