import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryRepositories } from "../../../packages/db/src/index.js";
import { createAppServer } from "../src/server.js";
import { createRepositoryBackedOrchestrator } from "../src/runtime.js";

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

test("repository backed orchestrator stores explicit memory without calling AI", async () => {
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
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called when storing explicit memory");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Запомни, что я люблю короткие ответы",
    telegramUpdateId: 789,
  });

  assert.equal(response.answer.source, "memory_write");
  assert.match(response.answer.text, /Запомнил/);

  const memories = await repositories.memories.listForActor({
    actorUserId: "owner-1",
    workspaceId: "workspace-family",
  });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].scope, "family");
  assert.equal(memories[0].subjectType, "user_stated_fact");
  assert.equal(memories[0].content, "я люблю короткие ответы");
});

test("repository backed orchestrator refuses to store explicit secret memory", async () => {
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
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called when refusing unsafe memory");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Запомни, что пароль от почты qwerty123",
    telegramUpdateId: 790,
  });

  assert.equal(response.answer.source, "memory_rejected");
  assert.match(response.answer.text, /не буду сохранять/i);

  const memories = await repositories.memories.listForActor({
    actorUserId: "owner-1",
    workspaceId: "workspace-family",
  });
  assert.equal(memories.length, 0);
});

test("repository backed orchestrator answers memory recall without calling AI", async () => {
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
        id: "memory-1",
        workspaceId: "workspace-family",
        ownerUserId: "owner-1",
        scope: "family",
        sensitivity: "normal",
        subjectType: "user_stated_fact",
        content: "я люблю короткие ответы",
        createdAt: new Date("2026-07-21T09:00:00.000Z"),
      },
    ],
  });
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for memory recall");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Что ты помнишь обо мне?",
    telegramUpdateId: 791,
  });

  assert.equal(response.answer.source, "memory_recall");
  assert.match(response.answer.text, /я люблю короткие ответы/);
});

test("repository backed orchestrator sends memory and recent history to AI", async () => {
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
        id: "memory-1",
        workspaceId: "workspace-family",
        ownerUserId: "owner-1",
        scope: "family",
        sensitivity: "normal",
        subjectType: "user_stated_fact",
        content: "я люблю короткие ответы",
        createdAt: new Date("2026-07-21T09:00:00.000Z"),
      },
    ],
  });
  const aiCalls = [];
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete(payload) {
        aiCalls.push(payload);
        return { text: "Коротко: связь работает." };
      },
    },
  });

  await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Что ты умеешь сложного?",
    telegramUpdateId: 790,
  });

  await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "technical_question",
    text: "А теперь ответь с учетом прошлого",
    telegramUpdateId: 791,
  });

  assert.equal(aiCalls.length, 2);
  const secondCall = aiCalls[1];
  assert.match(secondCall.messages[0].content, /я люблю короткие ответы/);
  assert.deepEqual(
    secondCall.messages.slice(1).map((message) => [message.role, message.content]),
    [
      ["user", "Что ты умеешь сложного?"],
      ["assistant", "Коротко: связь работает."],
      ["user", "А теперь ответь с учетом прошлого"],
    ],
  );
});

test("repository backed orchestrator extracts safe facts from ordinary dialogue", async () => {
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
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        return { text: "Учту." };
      },
    },
  });

  await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Я люблю короткие ответы без воды",
    telegramUpdateId: 792,
  });

  const memories = await repositories.memories.listForActor({
    actorUserId: "owner-1",
    workspaceId: "workspace-family",
  });

  assert.equal(memories.length, 1);
  assert.equal(memories[0].subjectType, "auto_observed_fact");
  assert.equal(memories[0].content, "Я люблю короткие ответы без воды");
});

test("repository backed orchestrator does not auto-store secrets from ordinary dialogue", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        return { text: "Не сохраняю секреты." };
      },
    },
  });

  await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Я люблю пароль qwerty1234567890 как тест",
    telegramUpdateId: 793,
  });

  const memories = await repositories.memories.listForActor({
    actorUserId: "owner-1",
    workspaceId: "workspace-family",
  });

  assert.equal(memories.length, 0);
});

test("repository backed orchestrator does not auto-store student details from ordinary dialogue", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        return { text: "Принято." };
      },
    },
  });

  await orchestrator({
    chatId: 777,
    actor: { id: "teacher-1", role: "teacher" },
    intent: "lesson_preparation",
    text: "На уроках ученик Иван часто путает Past Simple",
    telegramUpdateId: 799,
  });

  const memories = await repositories.memories.listForActor({
    actorUserId: "teacher-1",
    workspaceId: "workspace-family",
  });

  assert.equal(memories.length, 0);
});

test("repository backed orchestrator stores teacher materials and uses them as RAG context", async () => {
  const repositories = createInMemoryRepositories();
  const aiCalls = [];
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete(payload) {
        aiCalls.push(payload);
        return { text: "План урока готов." };
      },
    },
  });

  const stored = await orchestrator({
    chatId: 777,
    actor: { id: "teacher-1", role: "teacher" },
    intent: "material_search",
    text: "Сохрани материал: Past Simple warm-up\nIrregular verbs drill for A2 students.",
    telegramUpdateId: 794,
  });

  assert.equal(stored.answer.source, "material_write");
  assert.match(stored.answer.text, /Материал сохранен/);

  await orchestrator({
    chatId: 777,
    actor: { id: "teacher-1", role: "teacher" },
    intent: "lesson_preparation",
    text: "Подготовь урок про irregular verbs",
    telegramUpdateId: 795,
  });

  assert.equal(aiCalls.length, 1);
  assert.match(aiCalls[0].messages[0].content, /Relevant library materials/);
  assert.match(aiCalls[0].messages[0].content, /Irregular verbs drill/);
});

test("repository backed orchestrator answers diagnostics without calling AI", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for diagnostics");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "диагностика",
    telegramUpdateId: 796,
  });

  assert.equal(response.answer.source, "diagnostics");
  assert.match(response.answer.text, /Самодиагностика/);
});

test("repository backed orchestrator uses weather capability before AI", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry: {
      has(capabilityId) {
        return capabilityId === "weather_forecast";
      },
      async run(capabilityId, args) {
        assert.equal(capabilityId, "weather_forecast");
        assert.equal(args.location, "Москва");
        return {
          text: "Погода: без осадков.",
          source: "weather_forecast",
        };
      },
    },
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for weather");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Какая погода в Москве на выходных?",
    telegramUpdateId: 797,
  });

  assert.equal(response.answer.source, "weather_forecast");
  assert.equal(response.answer.text, "Погода: без осадков.");
});

test("repository backed orchestrator returns missing capability instead of dead end", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry: {
      has() {
        return false;
      },
    },
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for current data without tools");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Какая актуальная цена iPhone?",
    telegramUpdateId: 798,
  });

  assert.equal(response.answer.source, "capability_missing");
  assert.match(response.answer.text, /web_current_data/);
});
