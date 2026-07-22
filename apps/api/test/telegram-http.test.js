import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryRepositories } from "../../../packages/db/src/index.js";
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

async function resolveWithin(promise, timeoutMs, message) {
  const timeout = Symbol("timeout");
  const result = await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(timeout), timeoutMs)),
  ]);

  if (result === timeout) {
    throw new Error(message);
  }

  return result;
}

async function waitFor(condition, timeoutMs, message) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(message);
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

test("POST /telegram/teacher/webhook uses the dedicated teacher bot sender", async () => {
  const sentMessages = [];
  const calls = [];

  await withServer(
    {
      users,
      orchestrator: async (request) => {
        calls.push(request);
        return { answer: { text: "Teacher bot answer" } };
      },
      dependencies: {
        telegramSenders: {
          teacher: {
            async sendMessage(message) {
              sentMessages.push(message);
              return { ok: true };
            },
          },
        },
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/teacher/webhook`, {
        update_id: 22,
        message: {
          chat: { id: 777 },
          from: { id: 200 },
          text: "lesson for B1",
        },
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).text, "Teacher bot answer");
    },
  );

  assert.equal(calls[0].telegramBotKey, "teacher");
  assert.deepEqual(sentMessages, [{ chatId: 777, text: "Teacher bot answer" }]);
});

test("POST /telegram/teacher/webhook answers /start through webhook response", async () => {
  let orchestratorCalled = false;
  const sentMessages = [];

  await withServer(
    {
      users,
      orchestrator: async () => {
        orchestratorCalled = true;
        return { answer: { text: "should not happen" } };
      },
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramSenders: {
          teacher: {
            async sendMessage(message) {
              sentMessages.push(message);
            },
          },
        },
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/teacher/webhook`, {
        update_id: 23,
        message: {
          chat: { id: 777 },
          from: { id: 200 },
          text: "/start",
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.method, "sendMessage");
      assert.equal(body.chat_id, 777);
      assert.equal(typeof body.text, "string");
      assert.ok(body.text.length > 0);
    },
  );

  assert.equal(orchestratorCalled, false);
  assert.deepEqual(sentMessages, []);
});

test("POST /telegram/teacher/webhook refuses unknown /start through webhook response", async () => {
  let orchestratorCalled = false;
  const sentMessages = [];

  await withServer(
    {
      users,
      orchestrator: async () => {
        orchestratorCalled = true;
        return { answer: { text: "should not happen" } };
      },
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramSenders: {
          teacher: {
            async sendMessage(message) {
              sentMessages.push(message);
            },
          },
        },
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/teacher/webhook`, {
        update_id: 25,
        message: {
          chat: { id: 888 },
          from: { id: 999 },
          text: "/start",
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.method, "sendMessage");
      assert.equal(body.chat_id, 888);
      assert.match(body.text, /Telegram ID: 999$/);
      assert.match(body.text, /Доступ не настроен/);
      assert.doesNotMatch(body.text, /Бот подключен/);
    },
  );

  assert.equal(orchestratorCalled, false);
  assert.deepEqual(sentMessages, []);
});

test("POST /telegram/daughter/webhook refuses wrong-role /start through webhook response", async () => {
  let orchestratorCalled = false;
  const sentMessages = [];

  await withServer(
    {
      users,
      orchestrator: async () => {
        orchestratorCalled = true;
        return { answer: { text: "should not happen" } };
      },
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramSenders: {
          daughter: {
            async sendMessage(message) {
              sentMessages.push(message);
            },
          },
        },
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/daughter/webhook`, {
        update_id: 26,
        message: {
          chat: { id: 777 },
          from: { id: 200 },
          text: "/start",
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.method, "sendMessage");
      assert.equal(body.chat_id, 777);
      assert.match(body.text, /Доступ не настроен/);
      assert.doesNotMatch(body.text, /Бот подключен/);
    },
  );

  assert.equal(orchestratorCalled, false);
  assert.deepEqual(sentMessages, []);
});

test("POST /telegram/teacher/webhook closes immediate response and uses regular sender as background fallback", async () => {
  let releaseOrchestrator;
  const orchestratorCanFinish = new Promise((resolve) => {
    releaseOrchestrator = resolve;
  });
  const sentMessages = [];
  const calls = [];

  await withServer(
    {
      users,
      orchestrator: async (request) => {
        calls.push(request);
        await orchestratorCanFinish;
        return { answer: { text: "Teacher async answer" } };
      },
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramBackgroundDelayMs: 0,
        telegramSenders: {
          teacher: {
            async sendMessage(message) {
              sentMessages.push(message);
              return { ok: true };
            },
          },
        },
      },
    },
    async (baseUrl) => {
      const responsePromise = postJson(`${baseUrl}/telegram/teacher/webhook`, {
        update_id: 24,
        message: {
          chat: { id: 777 },
          from: { id: 200 },
          text: "lesson for B1",
        },
      });

      let response;
      try {
        response = await resolveWithin(
          responsePromise,
          100,
          "webhook response waited for orchestrator",
        );
      } finally {
        releaseOrchestrator();
      }

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("connection"), "close");
      assert.ok(Number(response.headers.get("content-length")) > 0);
      assert.deepEqual(await response.json(), { ok: true });

      await waitFor(
        () => calls.length === 1,
        1000,
        "background AI handler was not called",
      );
      await waitFor(
        () => sentMessages.length === 1,
        1000,
        "regular sender was not used as background fallback",
      );
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(sentMessages, [{ chatId: 777, text: "Teacher async answer" }]);
});

test("POST /telegram/teacher/webhook sends only background AI answer through relay sender when configured", async () => {
  const sentMessages = [];
  const calls = [];

  await withServer(
    {
      users,
      orchestrator: async (request) => {
        calls.push(request);
        return { answer: { text: "Teacher async answer" } };
      },
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramBackgroundDelayMs: 0,
        telegramBackgroundSenders: {
          teacher: {
            async sendMessage(message) {
              sentMessages.push(message);
              return { ok: true };
            },
          },
        },
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/teacher/webhook`, {
        update_id: 124,
        message: {
          chat: { id: 777 },
          from: { id: 200 },
          text: "lesson for B1",
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, { ok: true });

      await waitFor(
        () => sentMessages.length === 1,
        1000,
        "background relay sender was not called",
      );
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(sentMessages, [{ chatId: 777, text: "Teacher async answer" }]);
});

test("POST /telegram/owner/webhook answers /learn once through background sender", async () => {
  const sentMessages = [];
  const chatActions = [];
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

  await withServer(
    {
      repositories,
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramBackgroundDelayMs: 0,
        telegramBackgroundSenders: {
          owner: {
            async sendChatAction(action) {
              chatActions.push(action);
              return { ok: true };
            },
            async sendMessage(message) {
              sentMessages.push(message);
              return { ok: true };
            },
          },
        },
        aiProvider: {
          async complete() {
            throw new Error("AI should not be called for /learn");
          },
        },
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/owner/webhook`, {
        update_id: 126,
        message: {
          chat: { id: 777 },
          from: { id: 100 },
          text: "/learn",
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, { ok: true });

      await waitFor(
        () => sentMessages.length === 1,
        1000,
        "background /learn sender was not called",
      );
    },
  );

  assert.deepEqual(chatActions, [{ chatId: 777, action: "typing" }]);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, 777);
  assert.match(sentMessages[0].text, /\/learn fact/);
});

test("POST /telegram/owner/webhook does not resend /learn answer for repeated update id", async () => {
  const sentMessages = [];
  const chatActions = [];
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
  const update = {
    update_id: 226,
    message: {
      chat: { id: 777 },
      from: { id: 100 },
      text: "/learn",
    },
  };

  await withServer(
    {
      repositories,
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramBackgroundDelayMs: 0,
        telegramBackgroundSenders: {
          owner: {
            async sendChatAction(action) {
              chatActions.push(action);
              return { ok: true };
            },
            async sendMessage(message) {
              sentMessages.push(message);
              return { ok: true };
            },
          },
        },
        aiProvider: {
          async complete() {
            throw new Error("AI should not be called for /learn");
          },
        },
      },
    },
    async (baseUrl) => {
      const first = await postJson(`${baseUrl}/telegram/owner/webhook`, update);
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { ok: true });

      await waitFor(
        () => sentMessages.length === 1,
        1000,
        "first /learn sender was not called",
      );

      const second = await postJson(`${baseUrl}/telegram/owner/webhook`, update);
      assert.equal(second.status, 200);
      assert.deepEqual(await second.json(), { ok: true });

      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  );

  assert.equal(sentMessages.length, 1);
  assert.equal(chatActions.length, 1);
});

test("POST /telegram/owner/webhook stores explicit memory once through background sender", async () => {
  const sentMessages = [];
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

  await withServer(
    {
      repositories,
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramBackgroundDelayMs: 0,
        telegramBackgroundSenders: {
          owner: {
            async sendMessage(message) {
              sentMessages.push(message);
              return { ok: true };
            },
          },
        },
        aiProvider: {
          async complete() {
            throw new Error("AI should not be called for explicit memory");
          },
        },
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/owner/webhook`, {
        update_id: 127,
        message: {
          chat: { id: 777 },
          from: { id: 100 },
          text: "Запомни https://rksurfmag.club/ мой журнал, я его автор и редактор",
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, { ok: true });

      await waitFor(
        () => sentMessages.length === 1,
        1000,
        "background explicit-memory sender was not called",
      );
    },
  );

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, 777);
  assert.match(sentMessages[0].text, /Запомнил/);
  assert.match(sentMessages[0].text, /rksurfmag\.club/);
});

test("POST /telegram/owner/webhook does not resend explicit memory answer for repeated update id", async () => {
  const sentMessages = [];
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
  const update = {
    update_id: 227,
    message: {
      chat: { id: 777 },
      from: { id: 100 },
      text: "Р—Р°РїРѕРјРЅРё, С‡С‚Рѕ СЏ РїСЂРµРґРїРѕС‡РёС‚Р°СЋ РєРѕСЂРѕС‚РєРёРµ РѕС‚РІРµС‚С‹",
    },
  };

  await withServer(
    {
      repositories,
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramBackgroundDelayMs: 0,
        telegramBackgroundSenders: {
          owner: {
            async sendMessage(message) {
              sentMessages.push(message);
              return { ok: true };
            },
          },
        },
        aiProvider: {
          async complete() {
            throw new Error("AI should not be called for explicit memory");
          },
        },
      },
    },
    async (baseUrl) => {
      const first = await postJson(`${baseUrl}/telegram/owner/webhook`, update);
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { ok: true });

      await waitFor(
        () => sentMessages.length === 1,
        1000,
        "first explicit-memory sender was not called",
      );

      const second = await postJson(`${baseUrl}/telegram/owner/webhook`, update);
      assert.equal(second.status, 200);
      assert.deepEqual(await second.json(), { ok: true });

      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  );

  assert.equal(sentMessages.length, 1);
});

test("POST /telegram/owner/webhook fails closed when production secret is required but missing", async () => {
  await withServer(
    {
      dependencies: {
        telegramRequireWebhookSecret: true,
      },
      users,
      orchestrator: async () => {
        throw new Error("orchestrator should not be called");
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/owner/webhook`, {
        update_id: 125,
        message: {
          chat: { id: 777 },
          from: { id: 100 },
          text: "hello",
        },
      });

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "telegram_webhook_secret_not_configured",
      });
    },
  );
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

test("POST /telegram/webhook accepts direct Telegram secret when relay secret is configured", async () => {
  await withServer(
    {
      dependencies: {
        telegramWebhookSecret: "secret-token",
        telegramRelayWebhookSecret: "relay-secret",
      },
      users,
      orchestrator: async () => ({ answer: { text: "Direct Telegram ok" } }),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/telegram/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "secret-token",
        },
        body: JSON.stringify({
          update_id: 46,
          message: {
            chat: { id: 777 },
            from: { id: 200 },
            text: "lesson for B1",
          },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).text, "Direct Telegram ok");
    },
  );
});

test("POST /telegram/teacher/webhook uses dedicated webhook secret", async () => {
  await withServer(
    {
      dependencies: {
        telegramWebhookSecret: "default-secret",
        telegramWebhookSecrets: {
          teacher: "teacher-secret",
        },
      },
      users,
      orchestrator: async () => ({ answer: { text: "Teacher secret ok" } }),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/telegram/teacher/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "teacher-secret",
        },
        body: JSON.stringify({
          update_id: 44,
          message: {
            chat: { id: 777 },
            from: { id: 200 },
            text: "lesson for B1",
          },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).text, "Teacher secret ok");
    },
  );
});

test("POST /telegram/daughter/webhook rejects teacher account", async () => {
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
      const response = await postJson(`${baseUrl}/telegram/daughter/webhook`, {
        update_id: 45,
        message: {
          chat: { id: 777 },
          from: { id: 200 },
          text: "lesson for B1",
        },
      });

      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.chatId, 777);
    },
  );

  assert.equal(orchestratorCalled, false);
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

test("POST /telegram/webhook refuses unknown user through webhook response without sender", async () => {
  let orchestratorCalled = false;
  const sentMessages = [];

  await withServer(
    {
      users,
      orchestrator: async () => {
        orchestratorCalled = true;
        return { answer: { text: "should not happen" } };
      },
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramSender: {
          async sendMessage(message) {
            sentMessages.push(message);
          },
        },
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
      assert.equal(body.method, "sendMessage");
      assert.equal(body.chat_id, 888);
      assert.match(body.text, /Доступ не настроен/);
    },
  );

  assert.equal(orchestratorCalled, false);
  assert.deepEqual(sentMessages, []);
});

test("GET /health still works on app server", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ok");
  });
});
