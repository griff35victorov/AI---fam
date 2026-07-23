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

function normalizeTelegramPollingStateCreate(state, now = new Date()) {
  const nowDate = new Date(now);
  return {
    botKey: state.botKey,
    offset: state.offset ?? null,
    lockedUntil: state.lockedUntil ?? null,
    lockedBy: state.lockedBy ?? null,
    lastUpdateId: state.lastUpdateId ?? null,
    lastUpdateAt: state.lastUpdateAt ?? null,
    lastHeartbeatAt: state.lastHeartbeatAt ?? null,
    lastError: state.lastError ?? null,
    lastErrorAt: state.lastErrorAt ?? null,
    createdAt: state.createdAt ?? nowDate,
    updatedAt: state.updatedAt ?? nowDate,
  };
}

const tokenPattern = /[\p{L}\p{N}]{3,}/gu;

function tokenizeSearchText(text) {
  return Array.from(String(text ?? "").toLowerCase().matchAll(tokenPattern))
    .map((match) => match[0])
    .filter((token, index, tokens) => tokens.indexOf(token) === index);
}

function splitMaterialContent(content, maxChunkLength = 1200) {
  const normalized = String(content ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const chunks = [];
  let current = "";

  for (const paragraph of normalized.split(/\n{2,}/)) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= maxChunkLength) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (paragraph.length <= maxChunkLength) {
      current = paragraph;
      continue;
    }

    for (let index = 0; index < paragraph.length; index += maxChunkLength) {
      chunks.push(paragraph.slice(index, index + maxChunkLength).trim());
    }
    current = "";
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.filter(Boolean);
}

function buildMaterialChunkData(material, content) {
  const chunks = splitMaterialContent(content);
  const titleKeywords = tokenizeSearchText(material.title);
  const tagKeywords = tokenizeSearchText((material.tags ?? []).join(" "));

  return chunks.map((chunkContent, index) => {
    const keywords = [
      ...titleKeywords,
      ...tagKeywords,
      ...tokenizeSearchText(chunkContent).slice(0, 24),
    ].filter((keyword, keywordIndex, keywords) => keywords.indexOf(keyword) === keywordIndex);

    return {
      materialId: material.id,
      workspaceId: material.workspaceId,
      ownerUserId: material.ownerUserId,
      scope: material.scope,
      sensitivity: material.sensitivity,
      chunkIndex: index,
      content: chunkContent,
      keywords,
      tokenEstimate: Math.ceil(chunkContent.length / 4),
      metadata: null,
      createdAt: material.createdAt ?? new Date(),
    };
  });
}

function scoreMaterialChunk(chunk, material, queryTerms) {
  if (queryTerms.length === 0) return 1;

  const title = String(material?.title ?? "").toLowerCase();
  const content = String(chunk.content ?? "").toLowerCase();
  const tags = (material?.tags ?? []).join(" ").toLowerCase();
  const keywords = (chunk.keywords ?? []).join(" ").toLowerCase();

  return queryTerms.reduce((score, term) => {
    if (title.includes(term)) score += 6;
    if (tags.includes(term)) score += 4;
    if (keywords.includes(term)) score += 3;
    if (content.includes(term)) score += 2;
    return score;
  }, 0);
}

function claimWhere(now, { dedupeKey = null, type = null } = {}) {
  const where = {
    status: { in: ["queued", "running"] },
    runAt: { lte: now },
    OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
  };

  if (dedupeKey != null) {
    where.dedupeKey = dedupeKey;
  }

  if (type != null) {
    where.type = type;
  }

  return where;
}

function staleRunningWhere(now, { type = null } = {}) {
  const where = {
    status: "running",
    OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
  };

  if (type != null) {
    where.type = type;
  }

  return where;
}

function rescheduleWhere(job, {
  expectedStatus = null,
  expectedType = null,
  requireStaleLockAt = null,
} = {}) {
  const where = { id: job.id };

  if (expectedStatus != null) {
    where.status = expectedStatus;
  }

  if (expectedType != null) {
    where.type = expectedType;
  }

  if (requireStaleLockAt != null) {
    where.OR = [
      { lockedUntil: null },
      { lockedUntil: { lte: new Date(requireStaleLockAt) } },
    ];
  }

  return where;
}

async function claimJob(
  prisma,
  { workerId = null, now = new Date(), lockMs = defaultLockMs, dedupeKey = null, type = null } = {},
) {
  const nowDate = new Date(now);
  const lockUntil = new Date(nowDate.getTime() + lockMs);
  const where = claimWhere(nowDate, { dedupeKey, type });

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
        ...claimWhere(nowDate, { dedupeKey, type }),
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

      async findFirstByRole(role) {
        return prisma.user.findFirst({
          where: { role },
          orderBy: { createdAt: "asc" },
        });
      },
    },

    memories: {
      async create(memory) {
        return prisma.memoryItem.create({
          data: {
            workspaceId: memory.workspaceId,
            ownerUserId: memory.ownerUserId,
            scope: memory.scope,
            sensitivity: memory.sensitivity ?? "normal",
            subjectType: memory.subjectType,
            subjectId: memory.subjectId ?? null,
            content: memory.content,
            summary: memory.summary ?? null,
            sourceMessageIds: memory.sourceMessageIds ?? [],
            confidence: memory.confidence ?? 1,
            expiresAt: memory.expiresAt ?? null,
          },
        });
      },

      async listForActor({ actorUserId, workspaceId, includePrivate = false, limit = null }) {
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

        const memories = await prisma.memoryItem.findMany({
          where,
          orderBy: { createdAt: limit == null ? "asc" : "desc" },
          take: limit ?? undefined,
        });

        return limit == null ? memories : memories.reverse();
      },
    },

    ...(prisma.material?.create && prisma.materialChunk?.create
      ? {
          materials: {
            async create(material) {
              const createdAt = material.createdAt ?? new Date();
              const storedMaterial = await prisma.material.create({
                data: {
                  workspaceId: material.workspaceId,
                  ownerUserId: material.ownerUserId,
                  scope: material.scope ?? "teacher_private",
                  sensitivity: material.sensitivity ?? "normal",
                  title: material.title,
                  storageKey: material.storageKey ?? "inline",
                  mimeType: material.mimeType ?? "text/plain",
                  description: material.description ?? null,
                  tags: material.tags ?? [],
                  sourceMessageIds: material.sourceMessageIds ?? [],
                  createdAt,
                },
              });

              const chunkData = buildMaterialChunkData(
                storedMaterial,
                material.content ?? "",
              );
              const chunks = [];
              for (const chunk of chunkData) {
                chunks.push(await prisma.materialChunk.create({ data: chunk }));
              }

              return {
                ...storedMaterial,
                chunks,
              };
            },

            async listForActor({ actorUserId, workspaceId, limit = null }) {
              const where = {
                ownerUserId: actorUserId,
                sensitivity: { not: "secret" },
              };

              if (workspaceId != null) {
                where.workspaceId = workspaceId;
              }

              const materials = await prisma.material.findMany({
                where,
                orderBy: { createdAt: limit == null ? "asc" : "desc" },
                take: limit ?? undefined,
              });

              return limit == null ? materials : materials.reverse();
            },

            async search({ actorUserId, workspaceId, query, limit = 4 }) {
              const where = {
                ownerUserId: actorUserId,
                sensitivity: { not: "secret" },
              };

              if (workspaceId != null) {
                where.workspaceId = workspaceId;
              }

              const chunks = await prisma.materialChunk.findMany({
                where,
                orderBy: { createdAt: "desc" },
                take: 200,
              });

              const materialIds = [
                ...new Set(chunks.map((chunk) => chunk.materialId)),
              ];
              if (materialIds.length === 0) {
                return [];
              }

              const materials = await prisma.material.findMany({
                where: {
                  id: { in: materialIds },
                  ownerUserId: actorUserId,
                },
              });
              const materialsById = new Map(
                materials.map((material) => [material.id, material]),
              );
              const queryTerms = tokenizeSearchText(query);

              return chunks
                .map((chunk) => {
                  const material = materialsById.get(chunk.materialId);
                  return {
                    ...chunk,
                    materialTitle: material?.title ?? "Material",
                    title: material?.title ?? "Material",
                    tags: material?.tags ?? [],
                    score: scoreMaterialChunk(chunk, material, queryTerms),
                  };
                })
                .filter((chunk) => chunk.score > 0)
                .sort((left, right) => {
                  if (right.score !== left.score) return right.score - left.score;
                  return (
                    new Date(right.createdAt).getTime() -
                    new Date(left.createdAt).getTime()
                  );
                })
                .slice(0, Math.max(0, limit));
            },
          },
        }
      : {}),

    conversations: {
      async appendMessage(conversationId, message) {
        await ensureConversation(prisma, conversationId, message);

        return prisma.message.create({
          data: normalizeMessage(conversationId, message),
        });
      },

      async listMessages(conversationId, { limit = null } = {}) {
        const messages = await prisma.message.findMany({
          where: { conversationId },
          orderBy: { createdAt: limit == null ? "asc" : "desc" },
          take: limit ?? undefined,
        });

        return limit == null ? messages : messages.reverse();
      },
    },

    reminders: {
      async create(reminder) {
        return prisma.reminder.create({
          data: {
            userId: reminder.userId,
            workspaceId: reminder.workspaceId,
            title: reminder.title,
            runAt: new Date(reminder.runAt),
            timezone: reminder.timezone ?? "Europe/Moscow",
            status: reminder.status ?? "scheduled",
          },
        });
      },

      async listDue(now = new Date()) {
        return prisma.reminder.findMany({
          where: {
            status: "scheduled",
            runAt: { lte: new Date(now) },
          },
          orderBy: { runAt: "asc" },
        });
      },

      async listUpcoming({
        userId,
        workspaceId,
        now = new Date(),
        limit = 10,
      } = {}) {
        const where = {
          status: "scheduled",
          runAt: { gte: new Date(now) },
        };

        if (userId != null) where.userId = userId;
        if (workspaceId != null) where.workspaceId = workspaceId;

        return prisma.reminder.findMany({
          where,
          orderBy: { runAt: "asc" },
          take: limit,
        });
      },

      async updateStatus(id, status) {
        return prisma.reminder.update({
          where: { id },
          data: { status },
        });
      },

      async markSent(id) {
        return this.updateStatus(id, "sent");
      },
    },

    ...(prisma.auditLog?.create
      ? {
          auditLogs: {
            async create(auditLog) {
              return prisma.auditLog.create({
                data: {
                  actorId: auditLog.actorId ?? null,
                  action: auditLog.action,
                  resource: auditLog.resource,
                  metadata: auditLog.metadata ?? null,
                  createdAt: auditLog.createdAt ?? new Date(),
                },
              });
            },

            async listRecent({ actorId = null, action = null, limit = 20 } = {}) {
              const where = {};
              if (actorId != null) where.actorId = actorId;
              if (action != null) where.action = action;

              const auditLogs = await prisma.auditLog.findMany({
                where,
                orderBy: { createdAt: "desc" },
                take: limit,
              });

              return auditLogs.reverse();
            },
          },
        }
      : {}),

    ...(prisma.telegramPollingState?.findUnique
      ? {
          telegramPollingStates: {
            async get(botKey) {
              if (!botKey) return null;
              return prisma.telegramPollingState.findUnique({
                where: { botKey },
              });
            },

            async list() {
              return prisma.telegramPollingState.findMany({
                orderBy: { botKey: "asc" },
              });
            },

            async claimLease({
              botKey,
              workerId,
              now = new Date(),
              leaseMs = defaultLockMs,
            } = {}) {
              if (!botKey) throw new Error("botKey is required");
              const nowDate = new Date(now);
              const lockedUntil = new Date(nowDate.getTime() + leaseMs);

              try {
                const state = await prisma.telegramPollingState.create({
                  data: normalizeTelegramPollingStateCreate({
                    botKey,
                    lockedBy: workerId ?? null,
                    lockedUntil,
                    lastHeartbeatAt: nowDate,
                  }, nowDate),
                });

                return { claimed: true, state };
              } catch (error) {
                if (error?.code !== "P2002") {
                  throw error;
                }
              }

              const updated = await prisma.telegramPollingState.updateMany({
                where: {
                  botKey,
                  OR: [
                    { lockedUntil: null },
                    { lockedUntil: { lte: nowDate } },
                    { lockedBy: workerId ?? null },
                  ],
                },
                data: {
                  lockedBy: workerId ?? null,
                  lockedUntil,
                  lastHeartbeatAt: nowDate,
                  updatedAt: nowDate,
                },
              });

              const state = await prisma.telegramPollingState.findUnique({
                where: { botKey },
              });

              return { claimed: updated.count === 1, state };
            },

            async updateOffset({
              botKey,
              offset,
              lastUpdateId = null,
              now = new Date(),
            } = {}) {
              if (!botKey) throw new Error("botKey is required");
              const nowDate = new Date(now);
              return prisma.telegramPollingState.upsert({
                where: { botKey },
                update: {
                  offset: offset ?? undefined,
                  lastUpdateId: lastUpdateId ?? undefined,
                  lastUpdateAt: lastUpdateId == null ? undefined : nowDate,
                  lastHeartbeatAt: nowDate,
                  lastError: null,
                  lastErrorAt: null,
                  updatedAt: nowDate,
                },
                create: normalizeTelegramPollingStateCreate({
                  botKey,
                  offset,
                  lastUpdateId,
                  lastUpdateAt: lastUpdateId == null ? null : nowDate,
                  lastHeartbeatAt: nowDate,
                }, nowDate),
              });
            },

            async heartbeat({ botKey, now = new Date() } = {}) {
              if (!botKey) throw new Error("botKey is required");
              const nowDate = new Date(now);
              return prisma.telegramPollingState.upsert({
                where: { botKey },
                update: {
                  lastHeartbeatAt: nowDate,
                  updatedAt: nowDate,
                },
                create: normalizeTelegramPollingStateCreate({
                  botKey,
                  lastHeartbeatAt: nowDate,
                }, nowDate),
              });
            },

            async recordError({ botKey, error, now = new Date() } = {}) {
              if (!botKey) throw new Error("botKey is required");
              const nowDate = new Date(now);
              const message =
                typeof error === "string"
                  ? error
                  : error?.message ?? "telegram polling failed";

              return prisma.telegramPollingState.upsert({
                where: { botKey },
                update: {
                  lastError: message,
                  lastErrorAt: nowDate,
                  lastHeartbeatAt: nowDate,
                  updatedAt: nowDate,
                },
                create: normalizeTelegramPollingStateCreate({
                  botKey,
                  lastError: message,
                  lastErrorAt: nowDate,
                  lastHeartbeatAt: nowDate,
                }, nowDate),
              });
            },
          },
        }
      : {}),

    ...(prisma.job?.create && prisma.job?.findUnique
      ? {
          telegramDeliveries: {
            async get(key) {
              if (!key) {
                return null;
              }

              return prisma.job.findUnique({
                where: { dedupeKey: key },
              });
            },

            async claim({
              key,
              botKey = null,
              updateId = null,
              chatId = null,
              now = new Date(),
            } = {}) {
              if (!key) {
                return { claimed: true, delivery: null };
              }

              const nowDate = new Date(now);
              const lockedUntil = new Date(nowDate.getTime() + 5 * 60_000);
              try {
                const delivery = await prisma.job.create({
                  data: {
                    type: "telegram-delivery",
                    payload: { botKey, updateId, chatId },
                    status: "running",
                    result: { stage: "processing" },
                    runAt: nowDate,
                    attempts: 1,
                    lockedBy: "telegram-delivery",
                    lockedUntil,
                    dedupeKey: key,
                    createdAt: nowDate,
                    updatedAt: nowDate,
                  },
                });

                return { claimed: true, delivery };
              } catch (error) {
                if (error?.code !== "P2002") {
                  throw error;
                }

                const delivery = await prisma.job.findUnique({
                  where: { dedupeKey: key },
                });
                const lockExpired =
                  delivery?.lockedUntil != null &&
                  new Date(delivery.lockedUntil).getTime() <= nowDate.getTime();
                const retryableFailure =
                  delivery?.status === "failed" && delivery.result?.stage !== "send";
                const retryableExpiredProcessing =
                  delivery?.status === "running" &&
                  delivery.result?.stage === "processing" &&
                  lockExpired;

                if (retryableFailure || retryableExpiredProcessing) {
                  const reclaimed = await prisma.job.updateMany({
                    where: {
                      dedupeKey: key,
                      OR: [
                        {
                          status: "failed",
                          NOT: {
                            result: { path: ["stage"], equals: "send" },
                          },
                        },
                        {
                          status: "running",
                          result: { path: ["stage"], equals: "processing" },
                          lockedUntil: { lte: nowDate },
                        },
                      ],
                    },
                    data: {
                      status: "running",
                      result: { stage: "processing" },
                      error: null,
                      attempts: { increment: 1 },
                      lockedBy: "telegram-delivery",
                      lockedUntil,
                      updatedAt: nowDate,
                    },
                  });

                  if (reclaimed.count === 1) {
                    return {
                      claimed: true,
                      delivery: await prisma.job.findUnique({
                        where: { dedupeKey: key },
                      }),
                    };
                  }
                }

                return { claimed: false, delivery };
              }
            },

            async markSent(key, result = {}, now = new Date()) {
              return prisma.job.update({
                where: { dedupeKey: key },
                data: {
                  status: "completed",
                  result,
                  error: null,
                  lockedBy: null,
                  lockedUntil: null,
                  completedAt: new Date(now),
                  updatedAt: new Date(now),
                },
              });
            },

            async markSending(key, result = {}, now = new Date()) {
              const nowDate = new Date(now);
              return prisma.job.update({
                where: { dedupeKey: key },
                data: {
                  status: "running",
                  result: {
                    ...result,
                    stage: "send",
                  },
                  error: null,
                  lockedBy: "telegram-delivery",
                  lockedUntil: new Date(nowDate.getTime() + 5 * 60_000),
                  updatedAt: nowDate,
                },
              });
            },

            async markFailed(key, error = {}, now = new Date()) {
              const message =
                typeof error === "string"
                  ? error
                  : error?.message ?? error?.error ?? "telegram delivery failed";

              return prisma.job.update({
                where: { dedupeKey: key },
                data: {
                  status: "failed",
                  error: message,
                  result:
                    typeof error === "object" && error !== null
                      ? { error: message, ...error }
                      : { error: message },
                  lockedBy: null,
                  lockedUntil: null,
                  failedAt: new Date(now),
                  updatedAt: new Date(now),
                },
              });
            },
          },
        }
      : {}),

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

      async listRecent({ type = null, status = null, limit = 100 } = {}) {
        const where = {};
        const statuses = Array.isArray(status) ? status : status == null ? null : [status];
        if (type != null) {
          where.type = type;
        }
        if (statuses != null) {
          where.status = { in: statuses };
        }

        return prisma.job.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          take: Math.max(0, limit),
        });
      },

      async listStaleRunning({ type = null, now = new Date(), limit = 100 } = {}) {
        return prisma.job.findMany({
          where: staleRunningWhere(new Date(now), { type }),
          orderBy: { runAt: "asc" },
          take: Math.max(0, limit),
        });
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

      async rescheduleJob(job, result = {}, runAt = new Date(), now = new Date(), options = {}) {
        const nowDate = new Date(now);

        const updated = await prisma.job.updateMany({
          where: rescheduleWhere(job, options),
          data: {
            status: "queued",
            error: result.error ?? null,
            result,
            runAt: new Date(runAt),
            lockedBy: null,
            lockedUntil: null,
            failedAt: null,
            updatedAt: nowDate,
          },
        });

        if (updated.count !== 1) {
          return null;
        }

        return prisma.job.findUnique({
          where: { id: job.id },
        });
      },
    },
  };
}
