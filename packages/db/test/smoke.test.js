import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runPostgresSmoke, runPostgresSmokeCli } from "../src/index.js";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function matchesWhere(record, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") {
      return value.some((condition) => matchesWhere(record, condition));
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("in" in value) return value.in.includes(record[key]);
      if ("not" in value) return record[key] !== value.not;
      if ("lte" in value) return new Date(record[key]) <= new Date(value.lte);
    }

    return record[key] === value;
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
      let matches = rows.filter((row) => matchesWhere(row, where));

      if (orderBy) {
        const [[field, direction]] = Object.entries(orderBy);
        matches = [...matches].sort((left, right) => {
          const leftValue = new Date(left[field]).getTime();
          const rightValue = new Date(right[field]).getTime();
          return direction === "desc" ? rightValue - leftValue : leftValue - rightValue;
        });
      }

      return clone(matches[0] ?? null);
    },

    async findMany({ where, orderBy } = {}) {
      let matches = rows.filter((row) => matchesWhere(row, where));

      if (orderBy) {
        const [[field, direction]] = Object.entries(orderBy);
        matches = [...matches].sort((left, right) => {
          const leftValue = new Date(left[field]).getTime();
          const rightValue = new Date(right[field]).getTime();
          return direction === "desc" ? rightValue - leftValue : leftValue - rightValue;
        });
      }

      return matches.map(clone);
    },

    async create({ data }) {
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

    async updateMany({ where, data }) {
      const matched = rows.filter((row) => matchesWhere(row, where));

      for (const row of matched) {
        applyData(row, data);
      }

      return { count: matched.length };
    },

    async deleteMany({ where } = {}) {
      const before = rows.length;

      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matchesWhere(rows[index], where)) {
          rows.splice(index, 1);
        }
      }

      return { count: before - rows.length };
    },

    async upsert({ where, update, create }) {
      const [field, value] = Object.entries(where)[0];
      const existing = rows.find((row) => row[field] === value);

      if (existing) {
        applyData(existing, update);
        return clone(existing);
      }

      const stored = {
        id: create.id ?? `${idPrefix}-${nextId++}`,
        createdAt: create.createdAt ?? new Date(),
        updatedAt: create.updatedAt ?? new Date(),
        ...clone(create),
      };
      rows.push(stored);
      return clone(stored);
    },
  };
}

function createFakePrisma(seed = {}) {
  const data = {
    users: [...(seed.users ?? [])].map(clone),
    workspaces: [...(seed.workspaces ?? [])].map(clone),
    conversations: [...(seed.conversations ?? [])].map(clone),
    messages: [...(seed.messages ?? [])].map(clone),
    jobs: [...(seed.jobs ?? [])].map(clone),
  };

  const prisma = {
    user: createDelegate(data.users, "user"),
    workspace: createDelegate(data.workspaces, "workspace"),
    conversation: createDelegate(data.conversations, "conversation"),
    message: createDelegate(data.messages, "message"),
    job: createDelegate(data.jobs, "job"),
    async $transaction(callback) {
      return callback(prisma);
    },
    __data: data,
  };

  return prisma;
}

describe("PostgreSQL smoke runner", () => {
  it("requires explicit write opt-in", async () => {
    await assert.rejects(
      () =>
        runPostgresSmoke({
          prisma: createFakePrisma(),
          runId: "20260720T120000000Z",
        }),
      /FAMILY_AI_DB_SMOKE_ALLOW_WRITE/,
    );
  });

  it("seeds the minimal records and validates Prisma repository operations", async () => {
    const prisma = createFakePrisma({
      jobs: [
        {
          id: "existing-job",
          type: "send_reminder",
          payload: {},
          status: "queued",
          runAt: new Date("1969-01-01T00:00:00.000Z"),
          attempts: 0,
          lockedUntil: null,
          lockedBy: null,
          dedupeKey: "existing-job",
        },
      ],
    });

    const summary = await runPostgresSmoke({
      prisma,
      allowWrites: true,
      now: new Date("2026-07-20T12:00:00.000Z"),
      runId: "20260720T120000000Z",
    });

    assert.deepEqual(
      {
        workspaceId: summary.workspaceId,
        userId: summary.userId,
        conversationId: summary.conversationId,
        messageCount: summary.messageCount,
        jobStatus: summary.jobStatus,
      },
      {
        workspaceId: "smoke-workspace-20260720T120000000Z",
        userId: "smoke-user-20260720T120000000Z",
        conversationId: "smoke-conversation-20260720T120000000Z",
        messageCount: 2,
        jobStatus: "completed",
      },
    );
    assert.equal(summary.jobId, "job-1");
    assert.deepEqual(prisma.__data.workspaces, []);
    assert.deepEqual(prisma.__data.users, []);
    assert.deepEqual(prisma.__data.conversations, []);
    assert.deepEqual(prisma.__data.messages, []);
    assert.deepEqual(prisma.__data.jobs, [
      {
        id: "existing-job",
        type: "send_reminder",
        payload: {},
        status: "queued",
        runAt: new Date("1969-01-01T00:00:00.000Z"),
        attempts: 0,
        lockedUntil: null,
        lockedBy: null,
        dedupeKey: "existing-job",
      },
    ]);
  });

  it("requires a Prisma client", async () => {
    await assert.rejects(
      () => runPostgresSmoke({ prisma: null }),
      /prisma client is required/,
    );
  });

  it("does not mask setup errors with cleanup before the first write succeeds", async () => {
    const prisma = createFakePrisma();
    prisma.workspace.upsert = async () => {
      throw new Error("DATABASE_URL is missing");
    };
    prisma.message.deleteMany = async () => {
      throw new Error("cleanup should not run");
    };

    await assert.rejects(
      () =>
        runPostgresSmoke({
          prisma,
          allowWrites: true,
          runId: "20260720T120000000Z",
        }),
      /DATABASE_URL is missing/,
    );
  });

  it("prints a concise CLI error and returns a non-zero exit code", async () => {
    let stderr = "";

    const exitCode = await runPostgresSmokeCli({
      env: { FAMILY_AI_DB_SMOKE_ALLOW_WRITE: "1" },
      createClient: async () => {
        throw new Error("Missing Prisma Client");
      },
      stderr: {
        write(chunk) {
          stderr += chunk;
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(stderr, "Missing Prisma Client\n");
  });

  it("CLI refuses to create a client without explicit write opt-in", async () => {
    let stderr = "";
    let createClientCalled = false;

    const exitCode = await runPostgresSmokeCli({
      env: {},
      createClient: async () => {
        createClientCalled = true;
        return createFakePrisma();
      },
      stderr: {
        write(chunk) {
          stderr += chunk;
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(createClientCalled, false);
    assert.match(stderr, /FAMILY_AI_DB_SMOKE_ALLOW_WRITE/);
  });
});
