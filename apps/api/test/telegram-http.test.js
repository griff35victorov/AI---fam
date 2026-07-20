import assert from "node:assert/strict";
import test from "node:test";

import { createAppServer } from "../src/server.js";

const users = [
  { id: "teacher-1", role: "teacher", telegramUserId: "200" },
];

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

test("POST /telegram/webhook handles known Telegram update through injected orchestrator", async () => {
  const calls = [];

  await withServer(
    {
      users,
      orchestrator: async (request) => {
        calls.push(request);
        return { answer: { text: "Lesson plan ready" } };
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/webhook`, {
        update_id: 1,
        message: {
          chat: { id: 777 },
          from: { id: 200 },
          text: "lesson for B1",
        },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        chatId: 777,
        text: "Lesson plan ready",
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].actor.id, "teacher-1");
  assert.equal(calls[0].intent, "lesson_preparation");
  assert.equal(calls[0].text, "lesson for B1");
});

test("POST /orchestrator/handle uses injected orchestrator", async () => {
  const calls = [];

  await withServer(
    {
      orchestrator: async (request) => {
        calls.push(request);
        return { accepted: true, answer: { text: "Injected answer" } };
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/orchestrator/handle`, {
        actor: { id: "owner-1", role: "owner" },
        intent: "household",
        text: "hello",
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        accepted: true,
        answer: { text: "Injected answer" },
      });
    },
  );

  assert.equal(calls.length, 1);
});

test("POST /telegram/webhook sends Telegram message when sender is configured", async () => {
  const sentMessages = [];

  await withServer(
    {
      users,
      orchestrator: async () => ({ answer: { text: "Lesson sent" } }),
      dependencies: {
        telegramSender: {
          async sendMessage(message) {
            sentMessages.push(message);
            return { ok: true };
          },
        },
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/webhook`, {
        update_id: 2,
        message: {
          chat: { id: 777 },
          from: { id: 200 },
          text: "lesson for B1",
        },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        chatId: 777,
        text: "Lesson sent",
      });
    },
  );

  assert.deepEqual(sentMessages, [{ chatId: 777, text: "Lesson sent" }]);
});

test("POST /telegram/webhook rejects missing webhook secret when configured", async () => {
  await withServer(
    {
      dependencies: {
        telegramWebhookSecret: "secret-token",
      },
      users,
      orchestrator: async () => {
        throw new Error("orchestrator should not be called");
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/webhook`, {
        update_id: 3,
        message: {
          chat: { id: 777 },
          from: { id: 200 },
          text: "lesson for B1",
        },
      });

      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        error: "telegram_webhook_secret_invalid",
      });
    },
  );
});

test("POST /telegram/webhook accepts matching webhook secret", async () => {
  await withServer(
    {
      dependencies: {
        telegramWebhookSecret: "secret-token",
      },
      users,
      orchestrator: async () => ({ answer: { text: "Secret ok" } }),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/telegram/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "secret-token",
        },
        body: JSON.stringify({
          update_id: 4,
          message: {
            chat: { id: 777 },
            from: { id: 200 },
            text: "lesson for B1",
          },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).text, "Secret ok");
    },
  );
});

test("POST /telegram/webhook returns refusal text for unknown Telegram user", async () => {
  let orchestratorCalled = false;

  await withServer(
    {
      users,
      orchestrator: async () => {
        orchestratorCalled = true;
        return { answer: { text: "should not happen" } };
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/webhook`, {
        message: {
          chat: { id: 888 },
          from: { id: 999 },
          text: "hello",
        },
      });

      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.chatId, 888);
      assert.match(body.text, /Доступ не настроен/);
    },
  );

  assert.equal(orchestratorCalled, false);
});

test("GET /health still works on app server", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ok");
  });
});
