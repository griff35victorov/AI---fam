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

const normalizeMessage = (conversationId, message) => ({
  id: message.id ?? createId("message"),
  conversationId,
  role: message.role,
  content: message.content,
  metadata: message.metadata ?? null,
  createdAt: cloneDate(message.createdAt) ?? new Date(),
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
  createdAt: cloneDate(job.createdAt) ?? new Date(),
  updatedAt: cloneDate(job.updatedAt) ?? new Date(),
});

export const databasePackage = {
  name: "@family-ai/db",
  status: "in-memory-repositories",
};

export function createInMemoryRepositories(seed = {}) {
  const users = [...(seed.users ?? [])].map(cloneRecord);
  const memories = [...(seed.memories ?? [])].map(cloneRecord);
  const messages = [...(seed.messages ?? [])].map((message) => ({
    ...cloneRecord(message),
    createdAt: cloneDate(message.createdAt) ?? new Date(),
  }));
  const reminders = [...(seed.reminders ?? [])].map((reminder) => ({
    ...cloneRecord(reminder),
    runAt: cloneDate(reminder.runAt),
  }));
  const jobs = [...(seed.jobs ?? [])].map(normalizeJob);

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

  return {
    users: {
      async findByTelegramUserId(telegramUserId) {
        return cloneRecord(
          users.find((user) => user.telegramUserId === telegramUserId) ?? null,
        );
      },
    },

    memories: {
      async listForActor({ actorUserId, workspaceId, includePrivate = false }) {
        return memories
          .filter((memory) => {
            if (workspaceId != null && memory.workspaceId !== workspaceId) {
              return false;
            }

            if (memory.ownerUserId === actorUserId) {
              return true;
            }

            return includePrivate ? true : memory.sensitivity !== "private";
          })
          .sort(byCreatedAtAsc)
          .map(cloneRecord);
      },
    },

    conversations: {
      async appendMessage(conversationId, message) {
        const stored = normalizeMessage(conversationId, message);
        messages.push(stored);
        return cloneRecord(stored);
      },

      async listMessages(conversationId) {
        return messages
          .filter((message) => message.conversationId === conversationId)
          .sort(byCreatedAtAsc)
          .map(cloneRecord);
      },
    },

    reminders: {
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
