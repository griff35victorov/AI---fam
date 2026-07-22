let nextId = 1;

export { createPrismaClient } from "./client.js";
export { createPrismaRepositories } from "./prisma.js";
export { runPostgresSmoke, runPostgresSmokeCli } from "./smoke.js";
export {
  bootstrapUsers,
  bootstrapUsersFromEnv,
  parseBootstrapUsers,
  runBootstrapUsersCli,
} from "./bootstrap-users.js";

const cloneDate = (value) => (value == null ? value : new Date(value));

const cloneRecord = (record) => {
  if (record == null) {
    return null;
  }

  return structuredClone(record);
};

const createId = (prefix) => `${prefix}_${nextId++}`;

const byCreatedAtAsc = (left, right) =>
  new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();

const applyRecentLimit = (records, limit) => {
  if (limit == null) return records;
  return records.slice(-Math.max(0, limit));
};

const normalizeMessage = (conversationId, message) => ({
  id: message.id ?? createId("message"),
  conversationId,
  role: message.role,
  content: message.content,
  metadata: message.metadata ?? null,
  createdAt: cloneDate(message.createdAt) ?? new Date(),
});

const normalizeMemory = (memory) => ({
  id: memory.id ?? createId("memory"),
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
  expiresAt: cloneDate(memory.expiresAt) ?? null,
  createdAt: cloneDate(memory.createdAt) ?? new Date(),
  updatedAt: cloneDate(memory.updatedAt) ?? new Date(),
});

const normalizeMaterial = (material) => {
  const id = material.id ?? createId("material");

  return {
    id,
    workspaceId: material.workspaceId,
    ownerUserId: material.ownerUserId,
    scope: material.scope ?? "teacher_private",
    sensitivity: material.sensitivity ?? "normal",
    title: material.title,
    storageKey: material.storageKey ?? `inline:${id}`,
    mimeType: material.mimeType ?? "text/plain",
    description: material.description ?? null,
    tags: material.tags ?? [],
    sourceMessageIds: material.sourceMessageIds ?? [],
    createdAt: cloneDate(material.createdAt) ?? new Date(),
    updatedAt: cloneDate(material.updatedAt) ?? new Date(),
  };
};

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

function buildMaterialChunks(material, content) {
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
      id: createId("material_chunk"),
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
      createdAt: material.createdAt,
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

const normalizeAuditLog = (auditLog) => ({
  id: auditLog.id ?? createId("audit"),
  actorId: auditLog.actorId ?? null,
  action: auditLog.action,
  resource: auditLog.resource,
  metadata: auditLog.metadata ?? null,
  createdAt: cloneDate(auditLog.createdAt) ?? new Date(),
});

const normalizeJob = (job) => ({
  id: job.id ?? createId("job"),
  type: job.type,
  payload: job.payload ?? {},
  status: job.status ?? "queued",
  runAt: cloneDate(job.runAt) ?? new Date(),
  attempts: job.attempts ?? 0,
  lockedUntil: cloneDate(job.lockedUntil) ?? null,
  lockedBy: job.lockedBy ?? null,
  dedupeKey: job.dedupeKey ?? null,
  result: job.result ?? null,
  error: job.error ?? null,
  completedAt: cloneDate(job.completedAt) ?? null,
  failedAt: cloneDate(job.failedAt) ?? null,
  createdAt: cloneDate(job.createdAt) ?? new Date(),
  updatedAt: cloneDate(job.updatedAt) ?? new Date(),
});

const normalizeReminder = (reminder) => ({
  id: reminder.id ?? createId("reminder"),
  userId: reminder.userId,
  workspaceId: reminder.workspaceId,
  title: reminder.title,
  runAt: cloneDate(reminder.runAt) ?? new Date(),
  timezone: reminder.timezone ?? "Europe/Moscow",
  status: reminder.status ?? "scheduled",
  createdAt: cloneDate(reminder.createdAt) ?? new Date(),
  updatedAt: cloneDate(reminder.updatedAt) ?? new Date(),
});

export const databasePackage = {
  name: "@family-ai/db",
  status: "in-memory-repositories",
};

export function createInMemoryRepositories(seed = {}) {
  const users = [...(seed.users ?? [])].map(cloneRecord);
  const memories = [...(seed.memories ?? [])].map(normalizeMemory);
  const materials = [...(seed.materials ?? [])].map(normalizeMaterial);
  const materialChunks = [...(seed.materialChunks ?? [])].map(cloneRecord);
  const messages = [...(seed.messages ?? [])].map((message) => ({
    ...cloneRecord(message),
    createdAt: cloneDate(message.createdAt) ?? new Date(),
  }));
  const reminders = [...(seed.reminders ?? [])].map(normalizeReminder);
  const jobs = [...(seed.jobs ?? [])].map(normalizeJob);
  const auditLogs = [...(seed.auditLogs ?? [])].map(normalizeAuditLog);

  const claimJob = ({
    workerId = null,
    now = new Date(),
    lockMs = 60_000,
    dedupeKey = null,
  } = {}) => {
    const nowDate = new Date(now);
    const nowTime = nowDate.getTime();
    const claimable = jobs
      .filter((job) => {
        const lockExpired =
          job.lockedUntil == null ||
          new Date(job.lockedUntil).getTime() <= nowTime;

        return (
          (job.status === "queued" || job.status === "running") &&
          new Date(job.runAt).getTime() <= nowTime &&
          lockExpired &&
          (dedupeKey == null || job.dedupeKey === dedupeKey)
        );
      })
      .sort((left, right) => new Date(left.runAt) - new Date(right.runAt))[0];

    if (claimable == null) {
      return null;
    }

    claimable.status = "running";
    claimable.attempts += 1;
    claimable.lockedBy = workerId;
    claimable.lockedUntil = new Date(nowTime + lockMs);
    claimable.updatedAt = nowDate;

    return cloneRecord(claimable);
  };

  const updateJob = (jobId, updater) => {
    const stored = jobs.find((candidate) => candidate.id === jobId);

    if (stored == null) {
      return null;
    }

    updater(stored);
    return cloneRecord(stored);
  };

  const updateJobByDedupeKey = (dedupeKey, updater) => {
    const stored = jobs.find((candidate) => candidate.dedupeKey === dedupeKey);

    if (stored == null) {
      return null;
    }

    updater(stored);
    return cloneRecord(stored);
  };

  return {
    users: {
      async findByTelegramUserId(telegramUserId) {
        return cloneRecord(
          users.find((user) => user.telegramUserId === telegramUserId) ?? null,
        );
      },
    },

    memories: {
      async create(memory) {
        const stored = normalizeMemory(memory);
        memories.push(stored);
        return cloneRecord(stored);
      },

      async listForActor({ actorUserId, workspaceId, includePrivate = false, limit = null }) {
        const visibleMemories = memories
          .filter((memory) => {
            if (workspaceId != null && memory.workspaceId !== workspaceId) {
              return false;
            }

            if (memory.ownerUserId === actorUserId) {
              return true;
            }

            return includePrivate ? true : memory.sensitivity !== "private";
          })
          .sort(byCreatedAtAsc);

        return applyRecentLimit(visibleMemories, limit)
          .map(cloneRecord);
      },
    },

    materials: {
      async create(material) {
        const stored = normalizeMaterial(material);
        const chunks = buildMaterialChunks(stored, material.content ?? "");
        materials.push(stored);
        materialChunks.push(...chunks);
        return {
          ...cloneRecord(stored),
          chunks: chunks.map(cloneRecord),
        };
      },

      async listForActor({ actorUserId, workspaceId, limit = null }) {
        const visibleMaterials = materials
          .filter((material) => {
            if (workspaceId != null && material.workspaceId !== workspaceId) {
              return false;
            }

            return material.ownerUserId === actorUserId && material.sensitivity !== "secret";
          })
          .sort(byCreatedAtAsc);

        return applyRecentLimit(visibleMaterials, limit)
          .map(cloneRecord);
      },

      async search({ actorUserId, workspaceId, query, limit = 4 }) {
        const queryTerms = tokenizeSearchText(query);
        const materialsById = new Map(
          materials
            .filter((material) => {
              if (workspaceId != null && material.workspaceId !== workspaceId) {
                return false;
              }

              return material.ownerUserId === actorUserId && material.sensitivity !== "secret";
            })
            .map((material) => [material.id, material]),
        );

        return materialChunks
          .filter((chunk) => materialsById.has(chunk.materialId))
          .map((chunk) => {
            const material = materialsById.get(chunk.materialId);
            return {
              ...cloneRecord(chunk),
              materialTitle: material.title,
              title: material.title,
              tags: [...(material.tags ?? [])],
              score: scoreMaterialChunk(chunk, material, queryTerms),
            };
          })
          .filter((chunk) => chunk.score > 0)
          .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
          })
          .slice(0, Math.max(0, limit));
      },
    },

    conversations: {
      async appendMessage(conversationId, message) {
        const stored = normalizeMessage(conversationId, message);
        messages.push(stored);
        return cloneRecord(stored);
      },

      async listMessages(conversationId, { limit = null } = {}) {
        const conversationMessages = messages
          .filter((message) => message.conversationId === conversationId)
          .sort(byCreatedAtAsc);

        return applyRecentLimit(conversationMessages, limit)
          .map(cloneRecord);
      },
    },

    reminders: {
      async create(reminder) {
        const stored = normalizeReminder(reminder);
        reminders.push(stored);
        return cloneRecord(stored);
      },

      async listDue(now = new Date()) {
        const nowTime = new Date(now).getTime();

        return reminders
          .filter(
            (reminder) =>
              reminder.status === "scheduled" &&
              new Date(reminder.runAt).getTime() <= nowTime,
          )
          .sort((left, right) => new Date(left.runAt) - new Date(right.runAt))
          .map(cloneRecord);
      },

      async listUpcoming({
        userId,
        workspaceId,
        now = new Date(),
        limit = 10,
      } = {}) {
        const nowTime = new Date(now).getTime();

        return reminders
          .filter((reminder) => reminder.status === "scheduled")
          .filter((reminder) => userId == null || reminder.userId === userId)
          .filter((reminder) => workspaceId == null || reminder.workspaceId === workspaceId)
          .filter((reminder) => new Date(reminder.runAt).getTime() >= nowTime)
          .sort((left, right) => new Date(left.runAt) - new Date(right.runAt))
          .slice(0, Math.max(0, limit))
          .map(cloneRecord);
      },

      async updateStatus(id, status, now = new Date()) {
        const stored = reminders.find((reminder) => reminder.id === id);
        if (!stored) return null;

        stored.status = status;
        stored.updatedAt = cloneDate(now) ?? new Date();
        return cloneRecord(stored);
      },

      async markSent(id, now = new Date()) {
        return this.updateStatus(id, "sent", now);
      },
    },

    auditLogs: {
      async create(auditLog) {
        const stored = normalizeAuditLog(auditLog);
        auditLogs.push(stored);
        return cloneRecord(stored);
      },

      async listRecent({ actorId = null, action = null, limit = 20 } = {}) {
        const visibleAuditLogs = auditLogs
          .filter((auditLog) => actorId == null || auditLog.actorId === actorId)
          .filter((auditLog) => action == null || auditLog.action === action)
          .sort(byCreatedAtAsc);

        return applyRecentLimit(visibleAuditLogs, limit)
          .map(cloneRecord);
      },
    },

    telegramDeliveries: {
      async get(key) {
        if (!key) {
          return null;
        }

        return cloneRecord(jobs.find((candidate) => candidate.dedupeKey === key) ?? null);
      },

      async claim({ key, botKey = null, updateId = null, chatId = null, now = new Date() } = {}) {
        if (!key) {
          return { claimed: true, delivery: null };
        }

        const existing = jobs.find((candidate) => candidate.dedupeKey === key);
        if (existing != null) {
          if (existing.status === "failed" && existing.result?.stage !== "send") {
            const nowDate = cloneDate(now) ?? new Date();
            existing.status = "running";
            existing.attempts += 1;
            existing.lockedBy = "telegram-delivery";
            existing.lockedUntil = new Date(nowDate.getTime() + 5 * 60_000);
            existing.updatedAt = nowDate;
            return { claimed: true, delivery: cloneRecord(existing) };
          }

          return { claimed: false, delivery: cloneRecord(existing) };
        }

        const nowDate = cloneDate(now) ?? new Date();
        const stored = normalizeJob({
          type: "telegram-delivery",
          payload: { botKey, updateId, chatId },
          status: "running",
          runAt: nowDate,
          attempts: 1,
          lockedBy: "telegram-delivery",
          lockedUntil: new Date(nowDate.getTime() + 5 * 60_000),
          dedupeKey: key,
          createdAt: nowDate,
          updatedAt: nowDate,
        });
        jobs.push(stored);

        return { claimed: true, delivery: cloneRecord(stored) };
      },

      async markSent(key, result = {}, now = new Date()) {
        const nowDate = cloneDate(now) ?? new Date();

        return updateJobByDedupeKey(key, (stored) => {
          stored.status = "completed";
          stored.result = result;
          stored.error = null;
          stored.lockedBy = null;
          stored.lockedUntil = null;
          stored.completedAt = nowDate;
          stored.updatedAt = nowDate;
        });
      },

      async markFailed(key, error = {}, now = new Date()) {
        const nowDate = cloneDate(now) ?? new Date();
        const message =
          typeof error === "string"
            ? error
            : error?.message ?? error?.error ?? "telegram delivery failed";

        return updateJobByDedupeKey(key, (stored) => {
          stored.status = "failed";
          stored.error = message;
          stored.result =
            typeof error === "object" && error !== null
              ? { error: message, ...error }
              : { error: message };
          stored.lockedBy = null;
          stored.lockedUntil = null;
          stored.failedAt = nowDate;
          stored.updatedAt = nowDate;
        });
      },
    },

    jobs: {
      async enqueue(job) {
        if (job.dedupeKey != null) {
          const existing = jobs.find(
            (candidate) => candidate.dedupeKey === job.dedupeKey,
          );

          if (existing != null) {
            return cloneRecord(existing);
          }
        }

        const stored = normalizeJob(job);
        jobs.push(stored);
        return cloneRecord(stored);
      },

      async claim(options = {}) {
        return claimJob(options);
      },

      async claimNextJob(now = new Date()) {
        return claimJob({ now });
      },

      async completeJob(job, result, now = new Date()) {
        const nowDate = new Date(now);

        return updateJob(job.id, (stored) => {
          stored.status = "completed";
          stored.result = result;
          stored.lockedBy = null;
          stored.lockedUntil = null;
          stored.completedAt = nowDate;
          stored.updatedAt = nowDate;
        });
      },

      async failJob(job, result, now = new Date()) {
        const nowDate = new Date(now);

        return updateJob(job.id, (stored) => {
          stored.status = "failed";
          stored.error = result.error ?? null;
          stored.result = result;
          stored.attempts = job.attempts ?? result.attempts ?? stored.attempts;
          stored.lockedBy = null;
          stored.lockedUntil = null;
          stored.failedAt = nowDate;
          stored.updatedAt = nowDate;
        });
      },
    },
  };
}
