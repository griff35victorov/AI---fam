import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryRepositories } from "../../../packages/db/src/index.js";
import { createAppServer } from "../src/server.js";

async function withServer(options, run) {
  const server = createAppServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

async function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("Telegram webhook runs repository backed AI flow and stores conversation", async () => {
  const repositories = createInMemoryRepositories({
    users: [
      {
        id: "owner-1",
        role: "owner",
        telegramUserId: "100",
        workspaceId: "workspace-family",
      },
    ],
    memories: [
      {
        id: "family-style",
        workspaceId: "workspace-family",
        ownerUserId: "owner-1",
        scope: "family",
        sensitivity: "normal",
        subjectType: "preference",
        content: "Family prefers concise practical answers in Russian.",
        createdAt: new Date("2026-07-20T09:00:00.000Z"),
      },
      {
        id: "secret",
        workspaceId: "workspace-family",
        ownerUserId: "owner-1",
        scope: "family",
        sensitivity: "secret",
        subjectType: "credential",
        content: "Never expose this token.",
        createdAt: new Date("2026-07-20T09:01:00.000Z"),
      },
    ],
  });
  const aiCalls = [];

  await withServer(
    {
      dependencies: {
        repositories,
        aiProvider: {
          async complete(payload) {
            aiCalls.push(payload);
            return { text: "Короткий план готов." };
          },
        },
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/webhook`, {
        update_id: 123,
        message: {
          chat: { id: 777 },
          from: { id: 100 },
          text: "Сделай план бытовых дел на вечер",
        },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        chatId: 777,
        text: "Короткий план готов.",
      });
    },
  );

  assert.equal(aiCalls.length, 1);
  assert.match(aiCalls[0].messages[0].content, /concise practical answers/);
  assert.doesNotMatch(aiCalls[0].messages[0].content, /token/);

  const messages = await repositories.conversations.listMessages(
    "telegram:777:owner-1",
  );
  assert.deepEqual(
    messages.map((message) => [message.role, message.content]),
    [
      ["user", "Сделай план бытовых дел на вечер"],
      ["assistant", "Короткий план готов."],
    ],
  );
});

test("Telegram webhook reuses stored answer for repeated update id", async () => {
  const repositories = createInMemoryRepositories({
    users: [
      {
        id: "owner-1",
        role: "owner",
        telegramUserId: "100",
        workspaceId: "workspace-family",
      },
    ],
  });
  const aiCalls = [];

  await withServer(
    {
      dependencies: {
        repositories,
        aiProvider: {
          async complete(payload) {
            aiCalls.push(payload);
            return { text: `Ответ ${aiCalls.length}` };
          },
        },
      },
    },
    async (baseUrl) => {
      const update = {
        update_id: 456,
        message: {
          chat: { id: 777 },
          from: { id: 100 },
          text: "Повторяемая задача",
        },
      };

      const first = await postJson(`${baseUrl}/telegram/webhook`, update);
      const second = await postJson(`${baseUrl}/telegram/webhook`, update);

      assert.equal((await first.json()).text, "Ответ 1");
      assert.equal((await second.json()).text, "Ответ 1");
    },
  );

  assert.equal(aiCalls.length, 1);
  const messages = await repositories.conversations.listMessages(
    "telegram:777:owner-1",
  );
  assert.deepEqual(
    messages.map((message) => [message.role, message.content]),
    [
      ["user", "Повторяемая задача"],
      ["assistant", "Ответ 1"],
    ],
  );
});
