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

async function assertAcceptedWebhookMessage(response, chatId = 777) {
  const body = await response.json();
  assert.equal(body.method, "sendMessage");
  assert.equal(body.chat_id, chatId);
  assert.match(body.text, /Принял/);
  return body;
}

async function assertSilentWebhookAction(response, chatId = 777) {
  const body = await response.json();
  assert.equal(body.method, "sendChatAction");
  assert.equal(body.chat_id, chatId);
  assert.equal(body.action, "typing");
  return body;
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

test("GET /chat serves the fallback web chat page", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/chat`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(await response.text(), /\/web\/chat/);
  });
});

test("GET /chat exposes a file attachment control", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/chat`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /type="file"/);
    assert.match(html, /accept="[^"]*image\/\*/);
    assert.match(html, /FormData/);
  });
});

test("POST /web/chat fails closed when access code is missing or wrong", async () => {
  let orchestratorCalled = false;

  await withServer(
    {
      users: [{ id: "owner-1", role: "owner", workspaceId: "workspace-family" }],
      orchestrator: async () => {
        orchestratorCalled = true;
        return { answer: { text: "should not happen" } };
      },
    },
    async (baseUrl) => {
      const missingConfig = await postJson(`${baseUrl}/web/chat`, {
        role: "owner",
        accessCode: "test-code",
        message: "hello",
      });
      assert.equal(missingConfig.status, 503);
      assert.deepEqual(await missingConfig.json(), {
        error: "web_chat_access_code_not_configured",
      });
    },
  );

  await withServer(
    {
      users: [{ id: "owner-1", role: "owner", workspaceId: "workspace-family" }],
      webChatAccessCode: "test-code",
      orchestrator: async () => {
        orchestratorCalled = true;
        return { answer: { text: "should not happen" } };
      },
    },
    async (baseUrl) => {
      const wrongCode = await postJson(`${baseUrl}/web/chat`, {
        role: "owner",
        accessCode: "wrong",
        message: "hello",
      });
      assert.equal(wrongCode.status, 401);
      assert.deepEqual(await wrongCode.json(), {
        error: "web_chat_access_code_invalid",
      });
    },
  );

  assert.equal(orchestratorCalled, false);
});

test("POST /web/chat maps family role to existing DB user and calls orchestrator", async () => {
  const calls = [];
  const repositories = createInMemoryRepositories({
    users: [
      {
        id: "daughter-1",
        role: "family_child",
        workspaceId: "workspace-family",
      },
    ],
  });

  await withServer(
    {
      repositories,
      webChatAccessCode: "test-code",
      orchestrator: async (request) => {
        calls.push(request);
        return { accepted: true, answer: { text: "Web answer" } };
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/web/chat`, {
        role: "daughter",
        accessCode: "test-code",
        message: "english practice",
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        accepted: true,
        answer: { text: "Web answer" },
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].actor.id, "daughter-1");
  assert.equal(calls[0].actor.role, "family_child");
  assert.equal(calls[0].intent, "english_practice");
  assert.equal(calls[0].conversationId, "web:daughter:daughter-1");
});

test("POST /web/chat accepts a text file attachment and sends extracted text to the orchestrator", async () => {
  const calls = [];

  await withServer(
    {
      users: [{ id: "owner-1", role: "owner", workspaceId: "workspace-family" }],
      webChatAccessCode: "test-code",
      orchestrator: async (request) => {
        calls.push(request);
        return { accepted: true, answer: { text: "Attachment accepted" } };
      },
    },
    async (baseUrl) => {
      const form = new FormData();
      form.set("role", "owner");
      form.set("accessCode", "test-code");
      form.set("message", "Разбери файл");
      form.set(
        "attachment",
        new Blob(["Ключевые материалы урока: speaking warm-up"], {
          type: "text/plain",
        }),
        "lesson-notes.txt",
      );

      const response = await fetch(`${baseUrl}/web/chat`, {
        method: "POST",
        body: form,
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        accepted: true,
        answer: { text: "Attachment accepted" },
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /Разбери файл/);
  assert.match(calls[0].text, /lesson-notes\.txt/);
  assert.match(calls[0].text, /Ключевые материалы урока/);
});

test("POST /web/chat accepts an image attachment and sends OCR text to the orchestrator", async () => {
  const calls = [];
  const recognizedPaths = [];

  await withServer(
    {
      users: [{ id: "owner-1", role: "owner", workspaceId: "workspace-family" }],
      webChatAccessCode: "test-code",
      imageOcr: {
        async recognizeFile(imagePath) {
          recognizedPaths.push(imagePath);
          return "На изображении: беседка 3 на 4 метра";
        },
      },
      orchestrator: async (request) => {
        calls.push(request);
        return { accepted: true, answer: { text: "Image accepted" } };
      },
    },
    async (baseUrl) => {
      const form = new FormData();
      form.set("role", "owner");
      form.set("accessCode", "test-code");
      form.set("message", "Сделай чертеж по картинке");
      form.set(
        "attachment",
        new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], {
          type: "image/png",
        }),
        "gazebo.png",
      );

      const response = await fetch(`${baseUrl}/web/chat`, {
        method: "POST",
        body: form,
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        accepted: true,
        answer: { text: "Image accepted" },
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(recognizedPaths.length, 1);
  assert.match(calls[0].text, /Сделай чертеж по картинке/);
  assert.match(calls[0].text, /gazebo\.png/);
  assert.match(calls[0].text, /беседка 3 на 4 метра/);
});

test("POST /web/chat uses repository-backed orchestrator storage", async () => {
  const repositories = createInMemoryRepositories({
    users: [
      {
        id: "owner-1",
        role: "owner",
        workspaceId: "workspace-family",
      },
    ],
  });

  await withServer(
    {
      repositories,
      webChatAccessCode: "test-code",
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/web/chat`, {
        role: "owner",
        accessCode: "test-code",
        message: "hello from web",
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).conversationId, "web:owner:owner-1");
    },
  );

  const messages = await repositories.conversations.listMessages("web:owner:owner-1");
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(messages[0].content, "hello from web");
  assert.equal(messages[0].metadata.source, "web_chat");
  assert.equal(messages[0].metadata.telegramUpdateId, undefined);
  assert.equal(messages[1].metadata.source, "web_chat");
  assert.equal(messages[1].metadata.replyToTelegramUpdateId, undefined);
  assert.equal(typeof messages[1].content, "string");
  assert.ok(messages[1].content.length > 0);
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
      await assertAcceptedWebhookMessage(response);

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

test("POST /telegram/teacher/webhook returns visible ack and sends background AI answer through relay sender", async () => {
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
      await assertAcceptedWebhookMessage(response);

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

test("POST /telegram/owner/webhook keeps burst acknowledgements quiet while sending every final answer", async () => {
  const sentMessages = [];
  const calls = [];
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
      orchestrator: async (request) => {
        calls.push(request);
        return { answer: { text: `final answer ${request.telegramUpdateId}` } };
      },
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramUpdateDispatcherIntervalMs: 10,
        telegramBackgroundSenders: {
          owner: {
            async sendChatAction() {
              return { ok: true };
            },
            async sendMessage(message) {
              sentMessages.push(message);
              return { ok: true };
            },
          },
        },
      },
    },
    async (baseUrl) => {
      const responses = [];
      for (const [index, text] of ["first burst item", "second burst item", "third burst item"].entries()) {
        responses.push(await postJson(`${baseUrl}/telegram/owner/webhook`, {
          update_id: 500 + index,
          message: {
            message_id: 9200 + index,
            chat: { id: 777 },
            from: { id: 100 },
            text,
          },
        }));
      }

      assert.equal(responses[0].status, 200);
      await assertAcceptedWebhookMessage(responses[0]);
      assert.equal(responses[1].status, 200);
      await assertSilentWebhookAction(responses[1]);
      assert.equal(responses[2].status, 200);
      await assertSilentWebhookAction(responses[2]);

      await waitFor(
        () => sentMessages.length === 3,
        1000,
        "background sender did not deliver every burst answer",
      );
    },
  );

  assert.equal(calls.length, 3);
  assert.deepEqual(
    sentMessages.map((message) => message.text).sort(),
    ["final answer 500", "final answer 501", "final answer 502"],
  );
});

test("POST /telegram/owner/webhook queues valid updates before slow user lookup", async () => {
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
  const originalFindByTelegramUserId = repositories.users.findByTelegramUserId;
  let releaseUserLookup;
  const userLookupGate = new Promise((resolve) => {
    releaseUserLookup = resolve;
  });

  repositories.users.findByTelegramUserId = async (...args) => {
    await userLookupGate;
    return originalFindByTelegramUserId(...args);
  };

  await withServer(
    {
      repositories,
      orchestrator: async (request) => ({
        answer: { text: `final answer ${request.telegramUpdateId}` },
      }),
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramUpdateDispatcherIntervalMs: 10,
        telegramBackgroundSenders: {
          owner: {
            async sendChatAction() {
              return { ok: true };
            },
            async sendMessage(message) {
              sentMessages.push(message);
              return { ok: true };
            },
          },
        },
      },
    },
    async (baseUrl) => {
      const responsePromise = postJson(`${baseUrl}/telegram/owner/webhook`, {
        update_id: 900,
        message: {
          message_id: 9300,
          chat: { id: 777 },
          from: { id: 100 },
          text: "will it rain today?",
        },
      });

      const response = await resolveWithin(
        responsePromise,
        100,
        "webhook response waited for user lookup",
      );

      assert.equal(response.status, 200);
      await assertAcceptedWebhookMessage(response);

      releaseUserLookup();

      await waitFor(
        () => sentMessages.length === 1,
        1000,
        "queued Telegram update was not processed after user lookup resumed",
      );
    },
  );

  assert.deepEqual(sentMessages, [{ chatId: 777, text: "final answer 900" }]);
});

test("POST /telegram/owner/webhook waits for durable enqueue before ack", async () => {
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
  const originalEnqueue = repositories.jobs.enqueue;
  let releaseEnqueue;
  const enqueueGate = new Promise((resolve) => {
    releaseEnqueue = resolve;
  });

  repositories.jobs.enqueue = async (...args) => {
    await enqueueGate;
    return originalEnqueue(...args);
  };

  await withServer(
    {
      repositories,
      orchestrator: async (request) => ({
        answer: { text: `final answer ${request.telegramUpdateId}` },
      }),
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramUpdateDispatcherIntervalMs: 10,
        telegramBackgroundSenders: {
          owner: {
            async sendChatAction() {
              return { ok: true };
            },
            async sendMessage(message) {
              sentMessages.push(message);
              return { ok: true };
            },
          },
        },
      },
    },
    async (baseUrl) => {
      const responsePromise = postJson(`${baseUrl}/telegram/owner/webhook`, {
        update_id: 901,
        message: {
          message_id: 9301,
          chat: { id: 777 },
          from: { id: 100 },
          text: "weather tonight",
        },
      });

      let responseResolved = false;
      responsePromise.then(() => {
        responseResolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(responseResolved, false);

      releaseEnqueue();

      const response = await resolveWithin(
        responsePromise,
        1000,
        "webhook response did not resume after durable enqueue",
      );

      assert.equal(response.status, 200);
      await assertAcceptedWebhookMessage(response);

      await waitFor(
        () => sentMessages.length === 1,
        1000,
        "queued Telegram update was not processed after enqueue resumed",
      );
    },
  );

  assert.deepEqual(sentMessages, [{ chatId: 777, text: "final answer 901" }]);
});

test("POST /telegram/owner/webhook returns retryable error when durable enqueue fails", async () => {
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
  repositories.jobs.enqueue = async () => {
    throw new Error("database temporarily unavailable");
  };

  await withServer(
    {
      repositories,
      orchestrator: async () => {
        throw new Error("orchestrator should not run before queue accepts update");
      },
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramBackgroundSenders: {
          owner: {
            async sendMessage() {
              throw new Error("telegram sender should not run before queue accepts update");
            },
          },
        },
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/owner/webhook`, {
        update_id: 902,
        message: {
          message_id: 9302,
          chat: { id: 777 },
          from: { id: 100 },
          text: "weather tonight",
        },
      });

      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        error: "telegram_update_queue_failed",
      });
    },
  );
});

test("POST /telegram/owner/webhook answers connectivity check immediately without AI", async () => {
  const sentMessages = [];
  let orchestratorCalled = false;
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
      orchestrator: async () => {
        orchestratorCalled = true;
        return { answer: { text: "should not happen" } };
      },
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
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/owner/webhook`, {
        update_id: 224,
        message: {
          chat: { id: 777 },
          from: { id: 100 },
          text: "проверка связи",
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.method, "sendMessage");
      assert.equal(body.chat_id, 777);
      assert.match(body.text, /Связь установлена/);
    },
  );

  assert.equal(orchestratorCalled, false);
  assert.deepEqual(sentMessages, []);
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
      await assertAcceptedWebhookMessage(response);

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
      await assertAcceptedWebhookMessage(first);

      await waitFor(
        () => sentMessages.length === 1,
        1000,
        "first /learn sender was not called",
      );

      const second = await postJson(`${baseUrl}/telegram/owner/webhook`, update);
      assert.equal(second.status, 200);
      await assertSilentWebhookAction(second);

      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  );

  assert.equal(sentMessages.length, 1);
  assert.equal(chatActions.length, 1);
});

test("POST /telegram/owner/webhook does not resend answer for same Telegram message with new update id", async () => {
  const sentMessages = [];
  const chatActions = [];
  const calls = [];
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
  const message = {
    message_id: 9001,
    chat: { id: 777 },
    from: { id: 100 },
    text: "test 2",
  };

  await withServer(
    {
      repositories,
      orchestrator: async (request) => {
        calls.push(request);
        return { answer: { text: "single answer" } };
      },
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramBackgroundDelayMs: 0,
        telegramBackgroundSenders: {
          owner: {
            async sendChatAction(action) {
              chatActions.push(action);
              return { ok: true };
            },
            async sendMessage(messageToSend) {
              sentMessages.push(messageToSend);
              return { ok: true };
            },
          },
        },
      },
    },
    async (baseUrl) => {
      const first = await postJson(`${baseUrl}/telegram/owner/webhook`, {
        update_id: 326,
        message,
      });
      assert.equal(first.status, 200);
      await assertAcceptedWebhookMessage(first);

      await waitFor(
        () => sentMessages.length === 1,
        1000,
        "first message sender was not called",
      );

      const second = await postJson(`${baseUrl}/telegram/owner/webhook`, {
        update_id: 327,
        message,
      });
      assert.equal(second.status, 200);
      await assertSilentWebhookAction(second);

      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(chatActions, [{ chatId: 777, action: "typing" }]);
  assert.deepEqual(sentMessages, [{ chatId: 777, text: "single answer" }]);
});

test("POST /telegram/owner/webhook retries queued processing failure without duplicate reply", async () => {
  const sentMessages = [];
  const calls = [];
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
      orchestrator: async (request) => {
        calls.push(request);
        if (calls.length === 1) {
          throw new Error("temporary AI failure");
        }
        return { answer: { text: "answer after retry" } };
      },
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramUpdateDispatcherIntervalMs: 10,
        telegramUpdateDispatcherMaxAttempts: 2,
        telegramUpdateDispatcherRetryDelayMs: 10,
        telegramBackgroundSenders: {
          owner: {
            async sendChatAction() {
              return { ok: true };
            },
            async sendMessage(messageToSend) {
              sentMessages.push(messageToSend);
              return { ok: true };
            },
          },
        },
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/owner/webhook`, {
        update_id: 426,
        message: {
          message_id: 9101,
          chat: { id: 777 },
          from: { id: 100 },
          text: "answer after temporary error",
        },
      });

      assert.equal(response.status, 200);
      await assertAcceptedWebhookMessage(response);

      await waitFor(
        () => calls.length === 2 && sentMessages.length === 1,
        1000,
        "queued update was not retried exactly once",
      );
    },
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(sentMessages, [{ chatId: 777, text: "answer after retry" }]);
});

test("POST /telegram/owner/webhook does not retry after Telegram send was attempted", async () => {
  const sentMessages = [];
  const calls = [];
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
      orchestrator: async (request) => {
        calls.push(request);
        return { answer: { text: "possibly delivered answer" } };
      },
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramUpdateDispatcherIntervalMs: 10,
        telegramUpdateDispatcherMaxAttempts: 3,
        telegramUpdateDispatcherRetryDelayMs: 10,
        telegramBackgroundSenders: {
          owner: {
            async sendChatAction() {
              return { ok: true };
            },
            async sendMessage(messageToSend) {
              sentMessages.push(messageToSend);
              throw new Error("network failed after send attempt");
            },
          },
        },
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/owner/webhook`, {
        update_id: 427,
        message: {
          message_id: 9102,
          chat: { id: 777 },
          from: { id: 100 },
          text: "answer with ambiguous send result",
        },
      });

      assert.equal(response.status, 200);
      await assertAcceptedWebhookMessage(response);

      await waitFor(
        () => calls.length === 1 && sentMessages.length === 1,
        1000,
        "first send attempt was not reached",
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(sentMessages, [{ chatId: 777, text: "possibly delivered answer" }]);
});

test("POST /telegram/owner/webhook reports configuration error when background sender is missing", async () => {
  let orchestratorCalled = false;

  await withServer(
    {
      users: [
        {
          id: "owner-1",
          role: "owner",
          telegramUserId: "100",
          workspaceId: "workspace-family",
        },
      ],
      orchestrator: async () => {
        orchestratorCalled = true;
        return { answer: { text: "Should not run without sender" } };
      },
      dependencies: {
        telegramReplyMode: "webhook_response",
        telegramUpdateQueueEnabled: false,
      },
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/telegram/owner/webhook`, {
        update_id: 428,
        message: {
          message_id: 9103,
          chat: { id: 777 },
          from: { id: 100 },
          text: "normal question",
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.method, "sendMessage");
      assert.equal(body.chat_id, 777);
      assert.match(body.text, /Telegram relay/);
    },
  );

  assert.equal(orchestratorCalled, false);
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
      await assertAcceptedWebhookMessage(response);

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
      await assertAcceptedWebhookMessage(first);

      await waitFor(
        () => sentMessages.length === 1,
        1000,
        "first explicit-memory sender was not called",
      );

      const second = await postJson(`${baseUrl}/telegram/owner/webhook`, update);
      assert.equal(second.status, 200);
      await assertSilentWebhookAction(second);

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

test("POST /telegram/webhook rejects direct Telegram requests in relay-only ingress mode", async () => {
  await withServer(
    {
      dependencies: {
        telegramWebhookSecret: "secret-token",
        telegramRelayWebhookSecret: "relay-secret",
        telegramWebhookIngressMode: "relay",
      },
      users,
      orchestrator: async () => ({ answer: { text: "Should not run" } }),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/telegram/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "secret-token",
        },
        body: JSON.stringify({
          update_id: 47,
          message: {
            chat: { id: 777 },
            from: { id: 200 },
            text: "lesson for B1",
          },
        }),
      });

      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        error: "relay_secret_required",
      });
    },
  );
});

test("POST /telegram/webhook accepts relay requests in relay-only ingress mode", async () => {
  await withServer(
    {
      dependencies: {
        telegramWebhookSecret: "secret-token",
        telegramRelayWebhookSecret: "relay-secret",
        telegramWebhookIngressMode: "relay",
      },
      users,
      orchestrator: async () => ({ answer: { text: "Relay ok" } }),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/telegram/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "secret-token",
          "x-family-ai-relay-secret": "relay-secret",
        },
        body: JSON.stringify({
          update_id: 48,
          message: {
            chat: { id: 777 },
            from: { id: 200 },
            text: "lesson for B1",
          },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).text, "Relay ok");
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

test("reminder dispatcher uses background relay senders when configured", async () => {
  const repositories = createInMemoryRepositories({
    reminders: [
      {
        id: "reminder-1",
        userId: "owner-1",
        workspaceId: "workspace-family",
        title: "buy lamps",
        runAt: new Date("2026-07-20T12:00:00.000Z"),
        status: "scheduled",
      },
    ],
    jobs: [
      {
        id: "reminder-job-1",
        type: "send_reminder",
        payload: {
          reminderId: "reminder-1",
          title: "buy lamps",
          chatId: 777,
          botKey: "owner",
        },
        status: "queued",
        runAt: new Date("2026-07-20T12:00:00.000Z"),
        attempts: 0,
      },
    ],
  });
  const sentMessages = [];

  await withServer(
    {
      repositories,
      dependencies: {
        reminderDispatcherEnabled: true,
        reminderDispatcherIntervalMs: 60_000,
        telegramBackgroundSenders: {
          owner: {
            async sendMessage(message) {
              sentMessages.push(message);
              return { ok: true };
            },
          },
        },
      },
    },
    async () => {
      await waitFor(
        () => sentMessages.length === 1,
        1000,
        "background reminder sender was not called",
      );
    },
  );

  assert.deepEqual(sentMessages, [
    {
      chatId: 777,
      text: "Напоминание: buy lamps",
    },
  ]);
});

test("GET /health still works on app server", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ok");
  });
});
