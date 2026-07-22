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

  it("limits visible memories to the latest records in creation order", async () => {
    const repositories = createInMemoryRepositories({
      memories: [
        {
          id: "memory-1",
          workspaceId: "workspace-family",
          ownerUserId: "user-owner",
          scope: "family",
          sensitivity: "normal",
          subjectType: "preference",
          content: "First",
          createdAt: new Date("2026-07-20T09:00:00.000Z"),
        },
        {
          id: "memory-2",
          workspaceId: "workspace-family",
          ownerUserId: "user-owner",
          scope: "family",
          sensitivity: "normal",
          subjectType: "preference",
          content: "Second",
          createdAt: new Date("2026-07-20T10:00:00.000Z"),
        },
        {
          id: "memory-3",
          workspaceId: "workspace-family",
          ownerUserId: "user-owner",
          scope: "family",
          sensitivity: "normal",
          subjectType: "preference",
          content: "Third",
          createdAt: new Date("2026-07-20T11:00:00.000Z"),
        },
      ],
    });

    assert.deepEqual(
      (await repositories.memories.listForActor({
        actorUserId: "user-owner",
        workspaceId: "workspace-family",
        limit: 2,
      })).map((memory) => memory.id),
      ["memory-2", "memory-3"],
    );
  });

  it("stores material chunks and searches them for the owner", async () => {
    const repositories = createInMemoryRepositories();

    const material = await repositories.materials.create({
      workspaceId: "workspace-family",
      ownerUserId: "teacher-1",
      scope: "teacher_private",
      title: "Past Simple warm-up",
      content: "Past Simple drill with regular and irregular verbs.\n\nUse controlled practice.",
      tags: ["grammar", "A2"],
    });

    assert.equal(material.chunks.length, 1);

    const results = await repositories.materials.search({
      actorUserId: "teacher-1",
      workspaceId: "workspace-family",
      query: "irregular verbs",
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].materialTitle, "Past Simple warm-up");
    assert.match(results[0].content, /irregular verbs/);

    assert.deepEqual(
      await repositories.materials.search({
        actorUserId: "owner-1",
        workspaceId: "workspace-family",
        query: "irregular verbs",
      }),
      [],
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

  it("limits conversation messages to the latest records in creation order", async () => {
    const repositories = createInMemoryRepositories();

    await repositories.conversations.appendMessage("conversation-1", {
      role: "user",
      content: "First",
      createdAt: new Date("2026-07-20T09:00:00.000Z"),
    });
    await repositories.conversations.appendMessage("conversation-1", {
      role: "assistant",
      content: "Second",
      createdAt: new Date("2026-07-20T09:01:00.000Z"),
    });
    await repositories.conversations.appendMessage("conversation-1", {
      role: "user",
      content: "Third",
      createdAt: new Date("2026-07-20T09:02:00.000Z"),
    });

    assert.deepEqual(
      (await repositories.conversations.listMessages("conversation-1", {
        limit: 2,
      })).map((message) => message.content),
      ["Second", "Third"],
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

  it("can claim only the job matching a dedupe key", async () => {
    const repositories = createInMemoryRepositories({
      jobs: [
        {
          id: "existing-job",
          type: "send-reminder",
          payload: {},
          status: "queued",
          runAt: new Date("1969-01-01T00:00:00.000Z"),
          attempts: 0,
          dedupeKey: "existing-job",
        },
        {
          id: "target-job",
          type: "db-smoke",
          payload: {},
          status: "queued",
          runAt: new Date("1970-01-01T00:00:00.000Z"),
          attempts: 0,
          dedupeKey: "target-job",
        },
      ],
    });

    const claimed = await repositories.jobs.claim({
      workerId: "worker-1",
      now: new Date("1970-01-01T00:00:00.000Z"),
      dedupeKey: "target-job",
    });

    assert.equal(claimed.id, "target-job");
    assert.equal(
      await repositories.jobs.claim({
        workerId: "worker-2",
        now: new Date("1970-01-01T00:00:00.000Z"),
        dedupeKey: "missing-job",
      }),
      null,
    );
  });

  it("does not double-count attempts when failing a claimed job", async () => {
    const repositories = createInMemoryRepositories({
      jobs: [
        {
          id: "job-1",
          type: "send-reminder",
          payload: { reminderId: "reminder-1" },
          status: "queued",
          runAt: new Date("2026-07-20T12:00:00.000Z"),
          attempts: 0,
        },
      ],
    });

    const claimed = await repositories.jobs.claimNextJob(
      new Date("2026-07-20T12:01:00.000Z"),
    );
    const failed = await repositories.jobs.failJob(
      claimed,
      { status: "failed", error: "Network error", attempts: 2 },
      new Date("2026-07-20T12:02:00.000Z"),
    );

    assert.equal(claimed.attempts, 1);
    assert.equal(failed.attempts, 1);
  });

  it("claims Telegram delivery once and reclaims only processing failures", async () => {
    const repositories = createInMemoryRepositories();
    const key = "telegram:owner:123:reply";

    const first = await repositories.telegramDeliveries.claim({
      key,
      botKey: "owner",
      updateId: 123,
      chatId: 777,
    });
    const duplicate = await repositories.telegramDeliveries.claim({
      key,
      botKey: "owner",
      updateId: 123,
      chatId: 777,
    });

    assert.equal(first.claimed, true);
    assert.equal(duplicate.claimed, false);

    const retryBeforeProcessingLockExpires = await repositories.telegramDeliveries.claim({
      key,
      botKey: "owner",
      updateId: 123,
      chatId: 777,
    });
    assert.equal(retryBeforeProcessingLockExpires.claimed, false);

    const retryAfterProcessingLockExpires = await repositories.telegramDeliveries.claim({
      key,
      botKey: "owner",
      updateId: 123,
      chatId: 777,
      now: new Date(Date.now() + 6 * 60_000),
    });
    assert.equal(retryAfterProcessingLockExpires.claimed, true);

    await repositories.telegramDeliveries.markSending(key, { chatId: 777 });
    const retryAfterSendStarts = await repositories.telegramDeliveries.claim({
      key,
      botKey: "owner",
      updateId: 123,
      chatId: 777,
      now: new Date(Date.now() + 12 * 60_000),
    });
    assert.equal(retryAfterSendStarts.claimed, false);

    await repositories.telegramDeliveries.markFailed(key, {
      stage: "processing",
      error: "AI failed",
    });
    const retryAfterProcessingFailure = await repositories.telegramDeliveries.claim({
      key,
      botKey: "owner",
      updateId: 123,
      chatId: 777,
    });
    assert.equal(retryAfterProcessingFailure.claimed, true);

    await repositories.telegramDeliveries.markFailed(key, {
      stage: "send",
      error: "send timeout",
    });
    const retryAfterSendFailure = await repositories.telegramDeliveries.claim({
      key,
      botKey: "owner",
      updateId: 123,
      chatId: 777,
    });
    assert.equal(retryAfterSendFailure.claimed, false);
  });
});
