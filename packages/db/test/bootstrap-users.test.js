import assert from "node:assert/strict";
import test from "node:test";

import {
  bootstrapUsers,
  bootstrapUsersFromEnv,
  parseBootstrapUsers,
  runBootstrapUsersCli,
} from "../src/index.js";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function createUserDelegate(rows) {
  return {
    async upsert({ where, update, create }) {
      const [field, value] = Object.entries(where)[0];
      const existing = rows.find((row) => row[field] === value);

      if (existing) {
        Object.assign(existing, update);
        return clone(existing);
      }

      const stored = {
        createdAt: new Date("2026-07-21T00:00:00.000Z"),
        updatedAt: new Date("2026-07-21T00:00:00.000Z"),
        ...clone(create),
      };
      rows.push(stored);
      return clone(stored);
    },
  };
}

function createFakePrisma(seed = {}) {
  const users = [...(seed.users ?? [])].map(clone);

  return {
    user: createUserDelegate(users),
    async $disconnect() {},
    __data: { users },
  };
}

test("parseBootstrapUsers validates and normalizes family users", () => {
  const users = parseBootstrapUsers(
    JSON.stringify([
      {
        id: "owner",
        role: "owner",
        displayName: "Owner",
        telegramUserId: 701234567,
      },
    ]),
  );

  assert.deepEqual(users, [
    {
      id: "owner",
      role: "owner",
      displayName: "Owner",
      telegramUserId: "701234567",
      timezone: "Europe/Moscow",
    },
  ]);
});

test("parseBootstrapUsers rejects duplicate and placeholder Telegram ids", () => {
  assert.throws(
    () =>
      parseBootstrapUsers(
        JSON.stringify([
          {
            role: "owner",
            displayName: "Owner",
            telegramUserId: "701234567",
          },
          {
            role: "teacher",
            displayName: "Teacher",
            telegramUserId: "701234567",
          },
        ]),
      ),
    /duplicate telegramUserId/,
  );

  assert.throws(
    () =>
      parseBootstrapUsers(
        JSON.stringify([
          {
            role: "owner",
            displayName: "Owner",
            telegramUserId: "123456789",
          },
        ]),
      ),
    /placeholder telegramUserId/,
  );
});

test("bootstrapUsers upserts users and masks Telegram ids in summary", async () => {
  const prisma = createFakePrisma();

  const summary = await bootstrapUsers({
    prisma,
    allowWrites: true,
    users: [
      {
        id: "owner",
        role: "owner",
        displayName: "Owner",
        telegramUserId: "701234567",
      },
    ],
  });

  assert.equal(summary.count, 1);
  assert.equal(summary.users[0].telegramUserId, "70...67");
  assert.equal(prisma.__data.users[0].telegramUserId, "701234567");

  await bootstrapUsers({
    prisma,
    allowWrites: true,
    users: [
      {
        id: "owner",
        role: "teacher",
        displayName: "Updated Owner",
        telegramUserId: "701234567",
      },
    ],
  });

  assert.equal(prisma.__data.users.length, 1);
  assert.equal(prisma.__data.users[0].role, "teacher");
  assert.equal(prisma.__data.users[0].displayName, "Updated Owner");
});

test("bootstrapUsersFromEnv requires explicit write opt-in", async () => {
  await assert.rejects(
    () =>
      bootstrapUsersFromEnv({
        prisma: createFakePrisma(),
        env: {
          FAMILY_AI_BOOTSTRAP_USERS: JSON.stringify([
            {
              role: "owner",
              displayName: "Owner",
              telegramUserId: "701234567",
            },
          ]),
        },
      }),
    /FAMILY_AI_BOOTSTRAP_USERS_ALLOW_WRITE/,
  );
});

test("runBootstrapUsersCli prints concise errors", async () => {
  let stderr = "";
  let createClientCalled = false;

  const exitCode = await runBootstrapUsersCli({
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
  assert.match(stderr, /FAMILY_AI_BOOTSTRAP_USERS is empty/);
});
