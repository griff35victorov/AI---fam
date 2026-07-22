import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPrismaRepositories } from "../src/index.js";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function matchesWhere(record, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") {
      return value.some((condition) => matchesWhere(record, condition));
    }

    if (key === "NOT") {
      return !matchesWhere(record, value);
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("in" in value) return value.in.includes(record[key]);
      if ("not" in value) return record[key] !== value.not;
      if ("lte" in value) return new Date(record[key]) <= new Date(value.lte);
      if ("gte" in value) return new Date(record[key]) >= new Date(value.gte);
      if ("path" in value) {
        const actual = value.path.reduce(
          (current, part) => (current == null ? undefined : current[part]),
          record[key],
        );
        if ("equals" in value) return actual === value.equals;
      }
    }

    return record[key] === value;
  });
}

function sortRows(rows, orderBy) {
  if (!orderBy) return rows;

  const [[field, direction]] = Object.entries(orderBy);
  return [...rows].sort((left, right) => {
    const leftValue = new Date(left[field]).getTime();
    const rightValue = new Date(right[field]).getTime();
    return direction === "desc" ? rightValue - leftValue : leftValue - rightValue;
  });
}

function applyData(record, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "increment" in value) {
      record[key] += value.increment;
    } else {
      record[key] = value;
    }
  }
}

function createDelegate(rows, idPrefix) {
  let nextId = 1;

  return {
    async findUnique({ where }) {
      const [field, value] = Object.entries(where)[0];
      return clone(rows.find((row) => row[field] === value) ?? null);
    },

    async findFirst({ where, orderBy } = {}) {
      const matches = rows.filter((row) => matchesWhere(row, where));
      return clone(sortRows(matches, orderBy)[0] ?? null);
    },

    async findMany({ where, orderBy, take } = {}) {
      const sortedRows = sortRows(rows.filter((row) => matchesWhere(row, where)), orderBy);
      return (take == null ? sortedRows : sortedRows.slice(0, take)).map(clone);
    },

    async create({ data }) {
      if (
        data.dedupeKey != null &&
        rows.some((row) => row.dedupeKey === data.dedupeKey)
      ) {
        const error = new Error("Unique constraint failed on dedupeKey");
        error.code = "P2002";
        throw error;
      }

      const stored = {
        id: data.id ?? `${idPrefix}-${nextId++}`,
        createdAt: data.createdAt ?? new Date(),
        updatedAt: data.updatedAt ?? new Date(),
        ...clone(data),
      };
      rows.push(stored);
      return clone(stored);
    },

    async update({ where, data }) {
      const [field, value] = Object.entries(where)[0];
      const stored = rows.find((row) => row[field] === value);
      if (!stored) return null;

      applyData(stored, data);
      return clone(stored);
    },
  };
}

function createFakePrisma(seed = {}) {
  const data = {
    users: [...(seed.users ?? [])].map(clone),
    conversations: [...(seed.conversations ?? [])].map(clone),
    memoryItems: [...(seed.memoryItems ?? [])].map(clone),
    materials: [...(seed.materials ?? [])].map(clone),
    materialChunks: [...(seed.materialChunks ?? [])].map(clone),
    messages: [...(seed.messages ?? [])].map(clone),
    reminders: [...(seed.reminders ?? [])].map(clone),
    jobs: [...(seed.jobs ?? [])].map(clone),
    auditLogs: [...(seed.auditLogs ?? [])].map(clone),
  };

  const prisma = {
    user: createDelegate(data.users, "user"),
    conversation: createDelegate(data.conversations, "conversation"),
    memoryItem: createDelegate(data.memoryItems, "memory"),
    material: createDelegate(data.materials, "material"),
    materialChunk: createDelegate(data.materialChunks, "material-chunk"),
    message: createDelegate(data.messages, "message"),
    reminder: createDelegate(data.reminders, "reminder"),
    job: createDelegate(data.jobs, "job"),
    auditLog: createDelegate(data.auditLogs, "audit"),
    async $transaction(callback) {
      return callback(prisma);
    },
  };

  prisma.conversation.upsert = async ({ where, update, create }) => {
    const existing = data.conversations.find(
      (conversation) => conversation.id === where.id,
    );

    if (existing) {
      applyData(existing, update);
      return clone(existing);
    }

    data.conversations.push(clone(create));
    return clone(create);
  };
  prisma.job.updateMany = async ({ where, data: updateData }) => {
    const matched = data.jobs.filter((job) => matchesWhere(job, where));

    for (const job of matched) {
      applyData(job, updateData);
    }

    return { count: matched.length };
  };
  prisma.job.upsert = async ({ where, update, create }) => {
    const existing = data.jobs.find((job) => {
      const [field, value] = Object.entries(where)[0];
      return job[field] === value;
    });

    if (existing) {
      applyData(existing, update);
      return clone(existing);
    }

    const stored = {
      id: create.id ?? `job-${data.jobs.length + 1}`,
      createdAt: create.createdAt ?? new Date(),
      updatedAt: create.updatedAt ?? new Date(),
      ...clone(create),
    };
    data.jobs.push(stored);
    return clone(stored);
  };
  prisma.__data = data;

  return prisma;
}

describe("Prisma repositories", () => {
  it("finds users by Telegram user id", async () => {
    const repositories = createPrismaRepositories(
      createFakePrisma({
        users: [
          { id: "owner-1", role: "owner", telegramUserId: "100" },
          { id: "teacher-1", role: "teacher", telegramUserId: "200" },
        ],
      }),
    );

    assert.equal(
      (await repositories.users.findByTelegramUserId("200")).id,
      "teacher-1",
    );
    assert.equal(await repositories.users.findByTelegramUserId("missing"), null);
  });

  it("loads memories for actor and workspace", async () => {
    const repositories = createPrismaRepositories(
      createFakePrisma({
        memoryItems: [
          {
            id: "family-pref",
            workspaceId: "workspace-family",
            ownerUserId: "owner-1",
            scope: "family",
            sensitivity: "normal",
            content: "Family preference",
            createdAt: new Date("2026-07-20T09:00:00.000Z"),
          },
          {
            id: "teacher-private",
            workspaceId: "workspace-teacher",
            ownerUserId: "teacher-1",
            scope: "teacher_private",
            sensitivity: "private",
            content: "Private teacher note",
            createdAt: new Date("2026-07-20T10:00:00.000Z"),
          },
        ],
      }),
    );

    assert.deepEqual(
      (await repositories.memories.listForActor({
        actorUserId: "owner-1",
        workspaceId: "workspace-family",
      })).map((memory) => memory.id),
      ["family-pref"],
    );
  });

  it("limits visible memories to the latest records in creation order", async () => {
    const repositories = createPrismaRepositories(
      createFakePrisma({
        memoryItems: [
          {
            id: "memory-1",
            workspaceId: "workspace-family",
            ownerUserId: "owner-1",
            scope: "family",
            sensitivity: "normal",
            content: "First",
            createdAt: new Date("2026-07-20T09:00:00.000Z"),
          },
          {
            id: "memory-2",
            workspaceId: "workspace-family",
            ownerUserId: "owner-1",
            scope: "family",
            sensitivity: "normal",
            content: "Second",
            createdAt: new Date("2026-07-20T10:00:00.000Z"),
          },
          {
            id: "memory-3",
            workspaceId: "workspace-family",
            ownerUserId: "owner-1",
            scope: "family",
            sensitivity: "normal",
            content: "Third",
            createdAt: new Date("2026-07-20T11:00:00.000Z"),
          },
        ],
      }),
    );

    assert.deepEqual(
      (await repositories.memories.listForActor({
        actorUserId: "owner-1",
        workspaceId: "workspace-family",
        limit: 2,
      })).map((memory) => memory.id),
      ["memory-2", "memory-3"],
    );
  });

  it("stores and searches material chunks", async () => {
    const repositories = createPrismaRepositories(createFakePrisma());

    const material = await repositories.materials.create({
      workspaceId: "workspace-family",
      ownerUserId: "teacher-1",
      scope: "teacher_private",
      title: "Past Simple warm-up",
      content: "Past Simple drill with regular and irregular verbs.",
      tags: ["grammar"],
    });

    assert.equal(material.chunks.length, 1);

    const results = await repositories.materials.search({
      actorUserId: "teacher-1",
      workspaceId: "workspace-family",
      query: "irregular verbs",
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].materialTitle, "Past Simple warm-up");

    const list = await repositories.materials.listForActor({
      actorUserId: "teacher-1",
      workspaceId: "workspace-family",
    });

    assert.deepEqual(list.map((item) => item.title), ["Past Simple warm-up"]);
  });

  it("appends and lists conversation messages", async () => {
    const repositories = createPrismaRepositories(
      createFakePrisma({
        conversations: [
          {
            id: "conversation-1",
            userId: "owner-1",
            workspaceId: "workspace-family",
          },
        ],
      }),
    );

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
    const repositories = createPrismaRepositories(
      createFakePrisma({
        conversations: [
          {
            id: "conversation-1",
            userId: "owner-1",
            workspaceId: "workspace-family",
          },
        ],
      }),
    );

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

  it("rejects message append without existing conversation or ownership fields", async () => {
    const repositories = createPrismaRepositories(createFakePrisma());

    await assert.rejects(
      () =>
        repositories.conversations.appendMessage("conversation-1", {
          role: "user",
          content: "Hello",
        }),
      /Conversation ownership is required/,
    );
  });

  it("upserts conversation before appending messages when ownership is provided", async () => {
    const prisma = createFakePrisma();
    const repositories = createPrismaRepositories(prisma);

    await repositories.conversations.appendMessage("conversation-1", {
      role: "user",
      content: "Hello",
      userId: "owner-1",
      workspaceId: "workspace-family",
      createdAt: new Date("2026-07-20T09:00:00.000Z"),
    });

    const messages = await repositories.conversations.listMessages("conversation-1");

    assert.deepEqual(prisma.__data.conversations.map((conversation) => ({
      id: conversation.id,
      userId: conversation.userId,
      workspaceId: conversation.workspaceId,
    })), [
      {
        id: "conversation-1",
        userId: "owner-1",
        workspaceId: "workspace-family",
      },
    ]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].conversationId, "conversation-1");
  });

  it("lists due reminders", async () => {
    const repositories = createPrismaRepositories(
      createFakePrisma({
        reminders: [
          {
            id: "due",
            status: "scheduled",
            runAt: new Date("2026-07-20T11:59:00.000Z"),
          },
          {
            id: "future",
            status: "scheduled",
            runAt: new Date("2026-07-20T12:01:00.000Z"),
          },
        ],
      }),
    );

    assert.deepEqual(
      (await repositories.reminders.listDue(
        new Date("2026-07-20T12:00:00.000Z"),
      )).map((reminder) => reminder.id),
      ["due"],
    );
  });

  it("enqueues jobs with dedupe and claims unlocked due jobs", async () => {
    const repositories = createPrismaRepositories(createFakePrisma());
    const runAt = new Date("2026-07-20T12:00:00.000Z");

    const first = await repositories.jobs.enqueue({
      type: "send_reminder",
      payload: { reminderId: "reminder-1" },
      runAt,
      dedupeKey: "reminder-1",
    });
    const second = await repositories.jobs.enqueue({
      type: "send_reminder",
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
      }),
      null,
    );
  });

  it("uses upsert for deduplicated enqueue", async () => {
    let upsertCalled = false;
    const prisma = createFakePrisma();
    const originalUpsert = prisma.job.upsert;
    prisma.job.upsert = async (args) => {
      upsertCalled = true;
      return originalUpsert(args);
    };
    const repositories = createPrismaRepositories(prisma);

    await repositories.jobs.enqueue({
      type: "send_reminder",
      payload: { reminderId: "reminder-1" },
      runAt: new Date("2026-07-20T12:00:00.000Z"),
      dedupeKey: "reminder-1",
    });

    assert.equal(upsertCalled, true);
  });

  it("can claim only jobs matching a type", async () => {
    const repositories = createPrismaRepositories(createFakePrisma());
    const runAt = new Date("2026-07-20T12:00:00.000Z");

    const reminder = await repositories.jobs.enqueue({
      type: "send_reminder",
      payload: { reminderId: "reminder-1" },
      runAt,
      dedupeKey: "send_reminder:reminder-1",
    });
    const telegramUpdate = await repositories.jobs.enqueue({
      type: "telegram-update",
      payload: { botKey: "owner", update: { update_id: 1000 } },
      runAt,
      dedupeKey: "telegram-update:owner:update:1000",
    });

    const claimedTelegram = await repositories.jobs.claim({
      workerId: "telegram-worker",
      now: new Date("2026-07-20T12:01:00.000Z"),
      type: "telegram-update",
    });
    assert.equal(claimedTelegram.id, telegramUpdate.id);

    const claimedReminder = await repositories.jobs.claim({
      workerId: "reminder-worker",
      now: new Date("2026-07-20T12:01:00.000Z"),
      type: "send_reminder",
    });
    assert.equal(claimedReminder.id, reminder.id);
  });

  it("reclaims expired processing Telegram deliveries without retrying send-stage entries", async () => {
    const key = "telegram:owner:123:reply";
    const prisma = createFakePrisma({
      jobs: [
        {
          id: "job-telegram-1",
          type: "telegram-delivery",
          payload: { botKey: "owner", updateId: 123, chatId: 777 },
          status: "running",
          result: { stage: "processing" },
          runAt: new Date("2026-07-20T12:00:00.000Z"),
          attempts: 1,
          lockedBy: "telegram-delivery",
          lockedUntil: new Date("2026-07-20T12:05:00.000Z"),
          dedupeKey: key,
          createdAt: new Date("2026-07-20T12:00:00.000Z"),
          updatedAt: new Date("2026-07-20T12:00:00.000Z"),
        },
      ],
    });
    const repositories = createPrismaRepositories(prisma);

    const reclaimed = await repositories.telegramDeliveries.claim({
      key,
      botKey: "owner",
      updateId: 123,
      chatId: 777,
      now: new Date("2026-07-20T12:06:00.000Z"),
    });
    assert.equal(reclaimed.claimed, true);
    assert.equal(reclaimed.delivery.attempts, 2);
    assert.equal(reclaimed.delivery.result.stage, "processing");

    await repositories.telegramDeliveries.markSending(
      key,
      { chatId: 777 },
      new Date("2026-07-20T12:07:00.000Z"),
    );
    const afterSendStarted = await repositories.telegramDeliveries.claim({
      key,
      botKey: "owner",
      updateId: 123,
      chatId: 777,
      now: new Date("2026-07-20T12:20:00.000Z"),
    });
    assert.equal(afterSendStarted.claimed, false);
    assert.equal(afterSendStarted.delivery.result.stage, "send");
  });

  it("does not reclaim Telegram delivery if it moves to send stage during claim", async () => {
    const key = "telegram:owner:race:reply";
    const prisma = createFakePrisma({
      jobs: [
        {
          id: "job-telegram-race",
          type: "telegram-delivery",
          payload: { botKey: "owner", updateId: "race", chatId: 777 },
          status: "running",
          result: { stage: "processing" },
          runAt: new Date("2026-07-20T12:00:00.000Z"),
          attempts: 1,
          lockedBy: "telegram-delivery",
          lockedUntil: new Date("2026-07-20T12:05:00.000Z"),
          dedupeKey: key,
        },
      ],
    });
    const originalUpdateMany = prisma.job.updateMany;
    prisma.job.updateMany = async (args) => {
      const stored = prisma.__data.jobs.find((job) => job.dedupeKey === key);
      stored.result = { stage: "send" };
      stored.lockedUntil = new Date("2026-07-20T12:30:00.000Z");
      return originalUpdateMany(args);
    };
    const repositories = createPrismaRepositories(prisma);

    const result = await repositories.telegramDeliveries.claim({
      key,
      botKey: "owner",
      updateId: "race",
      chatId: 777,
      now: new Date("2026-07-20T12:06:00.000Z"),
    });

    assert.equal(result.claimed, false);
    assert.equal(prisma.__data.jobs[0].result.stage, "send");
    assert.equal(prisma.__data.jobs[0].attempts, 1);
  });

  it("uses conditional update when claiming jobs", async () => {
    const prisma = createFakePrisma({
      jobs: [
        {
          id: "job-1",
          type: "send_reminder",
          payload: {},
          status: "queued",
          runAt: new Date("2026-07-20T12:00:00.000Z"),
          attempts: 0,
          lockedUntil: null,
          lockedBy: null,
        },
      ],
    });
    const updateManyCalls = [];
    const originalUpdateMany = prisma.job.updateMany;
    prisma.job.updateMany = async (args) => {
      updateManyCalls.push(args);
      return originalUpdateMany(args);
    };
    const repositories = createPrismaRepositories(prisma);

    const claimed = await repositories.jobs.claim({
      workerId: "worker-1",
      now: new Date("2026-07-20T12:01:00.000Z"),
    });

    assert.equal(claimed.id, "job-1");
    assert.equal(updateManyCalls.length, 1);
    assert.equal(updateManyCalls[0].where.id, "job-1");
    assert.deepEqual(updateManyCalls[0].where.OR, [
      { lockedUntil: null },
      { lockedUntil: { lte: new Date("2026-07-20T12:01:00.000Z") } },
    ]);
  });

  it("lists stale running jobs even when they are older than recent jobs", async () => {
    const now = new Date("2026-07-22T12:00:00.000Z");
    const freshJobs = Array.from({ length: 220 }, (_, index) => ({
      id: `fresh-${index}`,
      type: "send_reminder",
      payload: {},
      status: "completed",
      runAt: new Date("2026-07-22T11:00:00.000Z"),
      updatedAt: new Date(now.getTime() - index * 1000),
    }));
    const repositories = createPrismaRepositories(
      createFakePrisma({
        jobs: [
          ...freshJobs,
          {
            id: "old-stale",
            type: "telegram-update",
            payload: {},
            status: "running",
            runAt: new Date("2026-07-22T10:00:00.000Z"),
            lockedUntil: new Date("2026-07-22T10:01:00.000Z"),
            updatedAt: new Date("2026-07-22T10:01:00.000Z"),
          },
        ],
      }),
    );

    const recent = await repositories.jobs.listRecent({ limit: 200 });
    const stale = await repositories.jobs.listStaleRunning({ now, limit: 10 });

    assert.equal(recent.some((job) => job.id === "old-stale"), false);
    assert.deepEqual(stale.map((job) => job.id), ["old-stale"]);
  });

  it("reschedules jobs conditionally to avoid racing fresh claims", async () => {
    const now = new Date("2026-07-22T12:00:00.000Z");
    const repositories = createPrismaRepositories(
      createFakePrisma({
        jobs: [
          {
            id: "stale-update",
            type: "telegram-update",
            payload: {},
            status: "running",
            runAt: new Date("2026-07-22T11:50:00.000Z"),
            attempts: 0,
            lockedUntil: new Date("2026-07-22T11:55:00.000Z"),
            lockedBy: "old-worker",
          },
        ],
      }),
    );
    const [stale] = await repositories.jobs.listStaleRunning({ now, limit: 10 });
    await repositories.jobs.claim({
      workerId: "fresh-worker",
      now,
      type: "telegram-update",
      lockMs: 60_000,
    });

    const rescheduled = await repositories.jobs.rescheduleJob(
      stale,
      { status: "supervisor_requeued" },
      now,
      now,
      {
        expectedStatus: "running",
        expectedType: "telegram-update",
        requireStaleLockAt: now,
      },
    );
    const jobs = await repositories.jobs.listRecent({ limit: 1 });

    assert.equal(rescheduled, null);
    assert.equal(jobs[0].status, "running");
    assert.equal(jobs[0].lockedBy, "fresh-worker");
  });

  it("supports worker completion and failure updates", async () => {
    const repositories = createPrismaRepositories(
      createFakePrisma({
        jobs: [
          {
            id: "job-1",
            type: "send_reminder",
            payload: { reminderId: "reminder-1" },
            status: "queued",
            runAt: new Date("2026-07-20T12:00:00.000Z"),
            attempts: 0,
            lockedUntil: null,
            lockedBy: null,
          },
          {
            id: "job-2",
            type: "send_reminder",
            payload: { reminderId: "reminder-2" },
            status: "queued",
            runAt: new Date("2026-07-20T12:01:00.000Z"),
            attempts: 0,
            lockedUntil: null,
            lockedBy: null,
          },
        ],
      }),
    );

    const first = await repositories.jobs.claimNextJob(
      new Date("2026-07-20T12:02:00.000Z"),
    );
    const completed = await repositories.jobs.completeJob(
      first,
      { status: "completed", output: { sent: true } },
      new Date("2026-07-20T12:03:00.000Z"),
    );

    assert.equal(completed.status, "completed");
    assert.equal(completed.lockedUntil, null);

    const second = await repositories.jobs.claimNextJob(
      new Date("2026-07-20T12:04:00.000Z"),
    );
    const failed = await repositories.jobs.failJob(
      second,
      { status: "failed", error: "Network error", attempts: 2 },
      new Date("2026-07-20T12:05:00.000Z"),
    );

    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "Network error");
    assert.equal(failed.attempts, 1);
  });
});
