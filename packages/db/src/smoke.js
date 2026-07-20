import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createPrismaClient } from "./client.js";
import { createPrismaRepositories } from "./prisma.js";

const smokeWorkerId = "db-smoke";
const smokeJobRunAt = new Date("1970-01-01T00:00:00.000Z");
const smokeWriteOptInEnv = "FAMILY_AI_DB_SMOKE_ALLOW_WRITE";
const smokeWriteOptInMessage =
  "PostgreSQL smoke writes temporary rows to the configured database. Set FAMILY_AI_DB_SMOKE_ALLOW_WRITE=1 or pass allowWrites: true to confirm this is an intentional smoke run.";

function formatRunId(now) {
  return new Date(now).toISOString().replace(/[-:.]/g, "");
}

function createSmokeIds(runId) {
  return {
    workspaceId: `smoke-workspace-${runId}`,
    userId: `smoke-user-${runId}`,
    telegramUserId: `smoke-telegram-${runId}`,
    conversationId: `smoke-conversation-${runId}`,
    dedupeKey: `smoke-job-${runId}`,
  };
}

function envAllowsWrites(env) {
  return ["1", "true", "yes"].includes(
    String(env?.[smokeWriteOptInEnv] ?? "").toLowerCase(),
  );
}

async function seedSmokeWorkspace(prisma, ids) {
  await prisma.workspace.upsert({
    where: { id: ids.workspaceId },
    update: { name: "Family AI DB Smoke Workspace" },
    create: {
      id: ids.workspaceId,
      kind: "family",
      name: "Family AI DB Smoke Workspace",
    },
  });
}

async function seedSmokeUser(prisma, ids) {
  await prisma.user.upsert({
    where: { id: ids.userId },
    update: {
      role: "owner",
      displayName: "DB Smoke Owner",
      telegramUserId: ids.telegramUserId,
      timezone: "Europe/Moscow",
    },
    create: {
      id: ids.userId,
      role: "owner",
      displayName: "DB Smoke Owner",
      telegramUserId: ids.telegramUserId,
      timezone: "Europe/Moscow",
    },
  });
}

async function cleanupSmokeRecords(prisma, ids) {
  await prisma.message.deleteMany({
    where: { conversationId: ids.conversationId },
  });
  await prisma.conversation.deleteMany({
    where: { id: ids.conversationId },
  });
  await prisma.job.deleteMany({
    where: { dedupeKey: ids.dedupeKey },
  });
  await prisma.user.deleteMany({
    where: { id: ids.userId },
  });
  await prisma.workspace.deleteMany({
    where: { id: ids.workspaceId },
  });
}

function assertSmoke(condition, message) {
  if (!condition) {
    throw new Error(`PostgreSQL smoke failed: ${message}`);
  }
}

export async function runPostgresSmoke({
  prisma,
  now = new Date(),
  runId = `${formatRunId(now)}-${randomUUID()}`,
  allowWrites = false,
  cleanup = true,
} = {}) {
  if (!prisma) {
    throw new Error("prisma client is required");
  }

  if (!allowWrites) {
    throw new Error(smokeWriteOptInMessage);
  }

  const ids = createSmokeIds(runId);
  let shouldCleanup = false;

  try {
    await seedSmokeWorkspace(prisma, ids);
    shouldCleanup = true;
    await seedSmokeUser(prisma, ids);

    const repositories = createPrismaRepositories(prisma);
    const owner = await repositories.users.findByTelegramUserId(ids.telegramUserId);

    assertSmoke(owner?.id === ids.userId, "smoke owner lookup returned an unexpected user");

    await repositories.conversations.appendMessage(ids.conversationId, {
      role: "user",
      content: "DB smoke user message",
      metadata: { smoke: true },
      userId: ids.userId,
      workspaceId: ids.workspaceId,
      createdAt: new Date(now),
    });
    await repositories.conversations.appendMessage(ids.conversationId, {
      role: "assistant",
      content: "DB smoke assistant message",
      metadata: { smoke: true },
      createdAt: new Date(new Date(now).getTime() + 1_000),
    });

    const messages = await repositories.conversations.listMessages(ids.conversationId);
    assertSmoke(messages.length === 2, "conversation round-trip did not persist two messages");

    const job = await repositories.jobs.enqueue({
      type: "db_smoke",
      payload: { conversationId: ids.conversationId },
      runAt: smokeJobRunAt,
      dedupeKey: ids.dedupeKey,
    });
    const claimed = await repositories.jobs.claim({
      workerId: smokeWorkerId,
      now: smokeJobRunAt,
      lockMs: 60_000,
      dedupeKey: ids.dedupeKey,
    });

    assertSmoke(claimed?.id === job.id, "job claim returned an unexpected job");

    const completed = await repositories.jobs.completeJob(
      claimed,
      { status: "completed", smoke: true },
      new Date(new Date(now).getTime() + 2_000),
    );

    assertSmoke(completed?.status === "completed", "job completion was not persisted");

    return {
      workspaceId: ids.workspaceId,
      userId: ids.userId,
      conversationId: ids.conversationId,
      messageCount: messages.length,
      jobId: job.id,
      jobStatus: completed.status,
    };
  } finally {
    if (cleanup && shouldCleanup) {
      await cleanupSmokeRecords(prisma, ids);
    }
  }
}

export async function runPostgresSmokeCli({
  createClient = createPrismaClient,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
} = {}) {
  if (!envAllowsWrites(env)) {
    stderr.write(`${smokeWriteOptInMessage}\n`);
    return 1;
  }

  let prisma;
  try {
    prisma = await createClient();
    const summary = await runPostgresSmoke({ prisma, allowWrites: true });
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error?.message ?? String(error)}\n`);
    return 1;
  } finally {
    await prisma?.$disconnect?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPostgresSmokeCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
