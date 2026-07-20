const defaultLockMs = 60_000;

function normalizeMessage(conversationId, message) {
  return {
    conversationId,
    role: message.role,
    content: message.content,
    metadata: message.metadata ?? null,
    createdAt: message.createdAt ?? new Date(),
  };
}

async function ensureConversation(prisma, conversationId, message) {
  if (!prisma.conversation?.upsert) {
    return;
  }

  if (!message.userId || !message.workspaceId) {
    const existing = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!existing) {
      throw new Error("Conversation ownership is required before appending messages");
    }

    return;
  }

  const timestamp = message.createdAt ?? new Date();

  await prisma.conversation.upsert({
    where: { id: conversationId },
    update: {
      updatedAt: timestamp,
    },
    create: {
      id: conversationId,
      userId: message.userId,
      workspaceId: message.workspaceId,
      title: message.title ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
}

function normalizeJob(job) {
  return {
    type: job.type,
    payload: job.payload ?? {},
    status: job.status ?? "queued",
    runAt: job.runAt ?? new Date(),
    attempts: job.attempts ?? 0,
    lockedUntil: job.lockedUntil ?? null,
    lockedBy: job.lockedBy ?? null,
    dedupeKey: job.dedupeKey ?? null,
  };
}

function claimWhere(now, { dedupeKey = null } = {}) {
  const where = {
    status: { in: ["queued", "running"] },
    runAt: { lte: now },
    OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
  };

  if (dedupeKey != null) {
    where.dedupeKey = dedupeKey;
  }

  return where;
}

async function claimJob(
  prisma,
  { workerId = null, now = new Date(), lockMs = defaultLockMs, dedupeKey = null } = {},
) {
  const nowDate = new Date(now);
  const lockUntil = new Date(nowDate.getTime() + lockMs);
  const where = claimWhere(nowDate, { dedupeKey });

  return prisma.$transaction(async (tx) => {
    const job = await tx.job.findFirst({
      where,
      orderBy: { runAt: "asc" },
    });

    if (!job) {
      return null;
    }

    const claimed = await tx.job.updateMany({
      where: {
        id: job.id,
        ...claimWhere(nowDate, { dedupeKey }),
      },
      data: {
        status: "running",
        attempts: { increment: 1 },
        lockedBy: workerId,
        lockedUntil: lockUntil,
        updatedAt: nowDate,
      },
    });

    if (claimed.count !== 1) {
      return null;
    }

    return tx.job.findUnique({
      where: { id: job.id },
    });
  });
}

export function createPrismaRepositories(prisma) {
  if (!prisma) {
    throw new Error("prisma client is required");
  }

  return {
    users: {
      async findByTelegramUserId(telegramUserId) {
        return prisma.user.findUnique({
          where: { telegramUserId: String(telegramUserId) },
        });
      },
    },

    memories: {
      async listForActor({ actorUserId, workspaceId, includePrivate = false }) {
        const where = {};

        if (workspaceId != null) {
          where.workspaceId = workspaceId;
        }

        if (!includePrivate) {
          where.OR = [
            { ownerUserId: actorUserId },
            { sensitivity: { not: "private" } },
          ];
        }

        return prisma.memoryItem.findMany({
          where,
          orderBy: { createdAt: "asc" },
        });
      },
    },

    conversations: {
      async appendMessage(conversationId, message) {
        await ensureConversation(prisma, conversationId, message);

        return prisma.message.create({
          data: normalizeMessage(conversationId, message),
        });
      },

      async listMessages(conversationId) {
        return prisma.message.findMany({
          where: { conversationId },
          orderBy: { createdAt: "asc" },
        });
      },
    },

    reminders: {
      async listDue(now = new Date()) {
        return prisma.reminder.findMany({
          where: {
            status: "scheduled",
            runAt: { lte: new Date(now) },
          },
          orderBy: { runAt: "asc" },
        });
      },
    },

    jobs: {
      async enqueue(job) {
        if (job.dedupeKey != null) {
          return prisma.job.upsert({
            where: { dedupeKey: job.dedupeKey },
            update: {},
            create: normalizeJob(job),
          });
        }

        return prisma.job.create({ data: normalizeJob(job) });
      },

      async claim(options = {}) {
        return claimJob(prisma, options);
      },

      async claimNextJob(now = new Date()) {
        return claimJob(prisma, { now });
      },

      async completeJob(job, result, now = new Date()) {
        const nowDate = new Date(now);

        return prisma.job.update({
          where: { id: job.id },
          data: {
            status: "completed",
            result,
            lockedBy: null,
            lockedUntil: null,
            completedAt: nowDate,
            updatedAt: nowDate,
          },
        });
      },

      async failJob(job, result, now = new Date()) {
        const nowDate = new Date(now);

        return prisma.job.update({
          where: { id: job.id },
          data: {
            status: "failed",
            error: result.error ?? null,
            result,
            attempts: job.attempts ?? result.attempts ?? 0,
            lockedBy: null,
            lockedUntil: null,
            failedAt: nowDate,
            updatedAt: nowDate,
          },
        });
      },
    },
  };
}
