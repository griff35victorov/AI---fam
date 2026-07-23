import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryRepositories } from "../../../packages/db/src/index.js";
import { createAppServer } from "../src/server.js";
import {
  createCapabilityRegistry,
  createPublicWebSearchProvider,
  parseWeatherRequest,
} from "../src/capabilities.js";
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

test("repository backed orchestrator explains Telegram learning commands", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for learning help");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "/learn",
    telegramUpdateId: 130,
  });

  assert.equal(response.answer.source, "learning_help");
  assert.match(response.answer.text, /\/learn fact/);
  assert.match(response.answer.text, /\/learn material/);
});

test("repository backed orchestrator stores Telegram learn fact without calling AI", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for learn fact");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "/learn fact Я предпочитаю краткие ответы с конкретными шагами",
    telegramUpdateId: 131,
  });

  assert.equal(response.answer.source, "learning_memory_write");
  const memories = await repositories.memories.listForActor({
    actorUserId: "owner-1",
    workspaceId: "workspace-family",
  });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].subjectType, "user_stated_fact");
  assert.match(memories[0].content, /краткие ответы/);
});

test("repository backed orchestrator redacts unsafe Telegram learn fact from conversation history", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for unsafe learn fact");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "/learn fact password for mailbox is qwerty123",
    telegramUpdateId: 136,
  });

  assert.equal(response.answer.source, "learning_memory_rejected");

  const messages = await repositories.conversations.listMessages(
    "telegram:777:owner-1",
  );
  assert.equal(messages[0].role, "user");
  assert.doesNotMatch(messages[0].content, /qwerty123/);
  assert.match(messages[0].metadata.redacted, /unsafe_learning_command/);
});

test("repository backed orchestrator does not duplicate Telegram learn fact after retry", async () => {
  const repositories = createInMemoryRepositories({
    messages: [
      {
        id: "msg-learn-fact",
        conversationId: "telegram:777:owner-1",
        role: "user",
        content: "/learn fact I prefer short answers",
        metadata: { telegramUpdateId: 1131 },
        createdAt: new Date("2026-07-22T09:00:00.000Z"),
      },
    ],
    memories: [
      {
        id: "memory-existing",
        workspaceId: "workspace-family",
        ownerUserId: "owner-1",
        scope: "family",
        sensitivity: "normal",
        subjectType: "user_stated_fact",
        content: "I prefer short answers",
        sourceMessageIds: ["msg-learn-fact"],
      },
    ],
  });
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for duplicate learn fact");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "/learn fact I prefer short answers",
    telegramUpdateId: 1131,
  });

  assert.equal(response.answer.source, "learning_memory_duplicate");
  const memories = await repositories.memories.listForActor({
    actorUserId: "owner-1",
    workspaceId: "workspace-family",
  });
  assert.equal(memories.length, 1);
});

test("repository backed orchestrator does not call AI when Telegram learning memory storage is unavailable", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories: {
      ...repositories,
      memories: null,
    },
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called when learn memory storage is unavailable");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "/learn fact I prefer concise answers",
    telegramUpdateId: 137,
  });

  assert.equal(response.answer.source, "learning_memory_unavailable");
  assert.match(response.answer.text, /подключена/i);
});

test("repository backed orchestrator stores teacher style through Telegram learn command", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for learn style");
      },
    },
  });

  const response = await orchestrator({
    chatId: 778,
    actor: { id: "teacher-1", role: "teacher" },
    intent: "lesson_preparation",
    text: "/learn style На уроках английского жена начинает с короткого speaking warm-up",
    telegramUpdateId: 132,
  });

  assert.equal(response.answer.source, "learning_memory_write");
  const memories = await repositories.memories.listForActor({
    actorUserId: "teacher-1",
    workspaceId: "workspace-family",
  });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].scope, "teacher_private");
  assert.equal(memories[0].subjectType, "teaching_style");
  assert.match(memories[0].content, /speaking warm-up/);
});

test("repository backed orchestrator stores Telegram learn material in RAG library", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for learn material");
      },
    },
  });

  const response = await orchestrator({
    chatId: 778,
    actor: { id: "teacher-1", role: "teacher" },
    intent: "material_search",
    text: "/learn material Past Simple warm-up\nAsk three questions about yesterday and correct one verb form.",
    telegramUpdateId: 133,
  });

  assert.equal(response.answer.source, "learning_material_write");
  const materials = await repositories.materials.listForActor({
    actorUserId: "teacher-1",
    workspaceId: "workspace-family",
  });
  assert.equal(materials.length, 1);
  assert.equal(materials[0].title, "Past Simple warm-up");
  const results = await repositories.materials.search({
    actorUserId: "teacher-1",
    workspaceId: "workspace-family",
    query: "yesterday verb",
  });
  assert.equal(results.length, 1);
});

test("repository backed orchestrator stores Russian Telegram learn material format", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for Russian learn material");
      },
    },
  });

  const response = await orchestrator({
    chatId: 778,
    actor: { id: "teacher-1", role: "teacher" },
    intent: "material_search",
    text: "Обучи материал: Irregular verbs drill\nУченики составляют 5 предложений в Past Simple.",
    telegramUpdateId: 135,
  });

  assert.equal(response.answer.source, "learning_material_write");
  const materials = await repositories.materials.listForActor({
    actorUserId: "teacher-1",
    workspaceId: "workspace-family",
  });
  assert.equal(materials.length, 1);
  assert.equal(materials[0].title, "Irregular verbs drill");
});

test("repository backed orchestrator does not duplicate Telegram learn material after retry", async () => {
  const repositories = createInMemoryRepositories({
    messages: [
      {
        id: "msg-learn-material",
        conversationId: "telegram:778:teacher-1",
        role: "user",
        content: "/learn material Past Simple warm-up\nAsk about yesterday.",
        metadata: { telegramUpdateId: 1133 },
        createdAt: new Date("2026-07-22T09:00:00.000Z"),
      },
    ],
    materials: [
      {
        id: "material-existing",
        workspaceId: "workspace-family",
        ownerUserId: "teacher-1",
        scope: "teacher_private",
        sensitivity: "normal",
        title: "Past Simple warm-up",
        sourceMessageIds: ["msg-learn-material"],
      },
    ],
  });
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for duplicate learn material");
      },
    },
  });

  const response = await orchestrator({
    chatId: 778,
    actor: { id: "teacher-1", role: "teacher" },
    intent: "material_search",
    text: "/learn material Past Simple warm-up\nAsk about yesterday.",
    telegramUpdateId: 1133,
  });

  assert.equal(response.answer.source, "learning_material_duplicate");
  const materials = await repositories.materials.listForActor({
    actorUserId: "teacher-1",
    workspaceId: "workspace-family",
  });
  assert.equal(materials.length, 1);
});

test("repository backed orchestrator lists Telegram learning memory and materials", async () => {
  const repositories = createInMemoryRepositories({
    memories: [
      {
        id: "memory-1",
        workspaceId: "workspace-family",
        ownerUserId: "teacher-1",
        scope: "teacher_private",
        sensitivity: "normal",
        subjectType: "teaching_style",
        content: "Start lessons with speaking warm-up.",
      },
    ],
    materials: [
      {
        id: "material-1",
        workspaceId: "workspace-family",
        ownerUserId: "teacher-1",
        scope: "teacher_private",
        sensitivity: "normal",
        title: "Past Simple warm-up",
        content: "Ask about yesterday.",
      },
    ],
  });
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for learn list");
      },
    },
  });

  const response = await orchestrator({
    chatId: 778,
    actor: { id: "teacher-1", role: "teacher" },
    intent: "material_search",
    text: "/learn list",
    telegramUpdateId: 134,
  });

  assert.equal(response.answer.source, "learning_list");
  assert.match(response.answer.text, /speaking warm-up/);
  assert.match(response.answer.text, /Past Simple warm-up/);
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
  const repositories = createInMemoryRepositories({
    jobs: [
      {
        id: "failed-telegram-update",
        type: "telegram-update",
        payload: {
          botKey: "owner",
          update: {
            update_id: 796,
            message: {
              message_id: 9601,
              chat: { id: 777 },
            },
          },
        },
        status: "failed",
        attempts: 2,
        result: {
          stage: "send",
          sendWasAttempted: true,
          error: "relay timeout",
        },
        error: "relay timeout",
      },
      {
        id: "failed-telegram-delivery",
        type: "telegram-delivery",
        payload: {
          botKey: "owner",
          updateId: 797,
          chatId: 777,
        },
        status: "failed",
        attempts: 1,
        result: {
          stage: "send",
          error: "relay returned 502",
        },
        error: "relay returned 502",
      },
    ],
  });
  await repositories.telegramPollingStates.updateOffset({
    botKey: "owner",
    offset: 42,
    lastUpdateId: 41,
    now: new Date("2026-07-23T08:00:00.000Z"),
  });
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
  assert.match(response.answer.text, /Telegram polling/);
  assert.match(response.answer.text, /offset 42/);
  assert.match(response.answer.text, /Failed jobs/);
  assert.match(response.answer.text, /id failed-t/);
  assert.match(response.answer.text, /type telegram-update/);
  assert.match(response.answer.text, /type telegram-delivery/);
  assert.match(response.answer.text, /sendWasAttempted yes/);
  assert.match(response.answer.text, /relay timeout/);
  assert.match(response.answer.text, /relay returned 502/);
});

test("repository backed orchestrator diagnostics include stale jobs outside recent window", async () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const freshJobs = Array.from({ length: 220 }, (_, index) => ({
    id: `fresh-${index}`,
    type: "send_reminder",
    payload: {},
    status: "completed",
    runAt: new Date("2026-07-22T11:00:00.000Z"),
    updatedAt: new Date(now.getTime() - index * 1000),
  }));
  const repositories = createInMemoryRepositories({
    jobs: [
      ...freshJobs,
      {
        id: "old-stale-telegram",
        type: "telegram-update",
        payload: { botKey: "owner", update: { update_id: 797 } },
        status: "running",
        runAt: new Date("2026-07-22T10:00:00.000Z"),
        lockedUntil: new Date("2026-07-22T10:01:00.000Z"),
        updatedAt: new Date("2026-07-22T10:01:00.000Z"),
        result: { stage: "processing" },
      },
    ],
  });
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    now: () => now,
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
    telegramUpdateId: 797,
  });

  assert.equal(response.answer.source, "diagnostics");
  assert.match(response.answer.text, /зависших running jobs: 1/);
});

test("repository backed orchestrator lets owner run supervisor repair from Telegram", async () => {
  const now = new Date("2026-07-22T12:00:00.000Z");
  const repositories = createInMemoryRepositories({
    jobs: [
      {
        id: "stale-telegram-update",
        type: "telegram-update",
        payload: { botKey: "owner", update: { update_id: 801 } },
        status: "running",
        runAt: new Date("2026-07-22T11:50:00.000Z"),
        lockedUntil: new Date("2026-07-22T11:55:00.000Z"),
        result: { stage: "processing" },
      },
      {
        id: "stale-reminder",
        type: "send_reminder",
        payload: { reminderId: "reminder-1" },
        status: "running",
        runAt: new Date("2026-07-22T11:50:00.000Z"),
        lockedUntil: new Date("2026-07-22T11:55:00.000Z"),
        result: { stage: "processing" },
      },
    ],
  });
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    now: () => now,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for supervisor repair");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "/repair",
    telegramUpdateId: 801,
  });

  assert.equal(response.answer.source, "supervisor_repair");
  assert.match(response.answer.text, /Supervisor-ремонт выполнен/);
  assert.match(response.answer.text, /Авто-лечением переотложено задач: 1/);

  const jobs = await repositories.jobs.listRecent({ limit: 10 });
  assert.equal(jobs.find((job) => job.id === "stale-telegram-update").status, "queued");
  assert.equal(jobs.find((job) => job.id === "stale-reminder").status, "running");
});

test("repository backed orchestrator gives web chat access code only to owner without storing secret", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    webChatAccessCode: "family-web-code",
    webChatUrl: "https://family.example/chat",
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for web chat access code");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "/webcode",
    telegramUpdateId: 901,
  });

  assert.equal(response.answer.source, "web_chat_access");
  assert.match(response.answer.text, /https:\/\/family\.example\/chat/);
  assert.match(response.answer.text, /family-web-code/);
  assert.equal(response.secretEphemeral, true);

  const messages = await repositories.conversations.listMessages("telegram:777:owner-1");
  assert.equal(messages.length, 0);
});

test("repository backed orchestrator understands short natural web chat code requests", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    webChatAccessCode: "family-web-code",
    webChatUrl: "https://family.example/chat",
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for natural web chat code request");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "выдай мне код на чат",
    telegramUpdateId: 904,
  });

  assert.equal(response.answer.source, "web_chat_access");
  assert.match(response.answer.text, /https:\/\/family\.example\/chat/);
  assert.match(response.answer.text, /family-web-code/);
  assert.equal(response.secretEphemeral, true);

  const messages = await repositories.conversations.listMessages("telegram:777:owner-1");
  assert.equal(messages.length, 0);
});

test("repository backed orchestrator treats its own web chat URL as an access request", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    webChatAccessCode: "family-web-code",
    webChatUrl: "https://family.example/chat",
    capabilityRegistry: {
      has() {
        return true;
      },
      async run() {
        throw new Error("web chat URL should not be fetched as an external URL");
      },
    },
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for own web chat URL");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Доступ к резервному веб-чату: Ссылка: https://family.example/chat",
    telegramUpdateId: 905,
  });

  assert.equal(response.answer.source, "web_chat_access");
  assert.match(response.answer.text, /https:\/\/family\.example\/chat/);
  assert.match(response.answer.text, /family-web-code/);

  const messages = await repositories.conversations.listMessages("telegram:777:owner-1");
  assert.equal(messages.length, 0);
});

test("repository backed orchestrator rejects web chat access code for non-owner", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    webChatAccessCode: "family-web-code",
    webChatUrl: "https://family.example/chat",
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for rejected web chat access code");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "daughter-1", role: "family_child" },
    intent: "study",
    text: "/webcode",
    telegramUpdateId: 902,
  });

  assert.equal(response.answer.source, "web_chat_access_rejected");
  assert.doesNotMatch(response.answer.text, /family-web-code/);
});

test("repository backed orchestrator explains missing web chat access config to owner", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    webChatUrl: "https://family.example/chat",
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called when web chat access code is missing");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "выдай мне код доступа для веб интерфейса",
    telegramUpdateId: 903,
  });

  assert.equal(response.answer.source, "web_chat_access");
  assert.match(response.answer.text, /WEB_CHAT_ACCESS_CODE/);
  assert.match(response.answer.text, /https:\/\/family\.example\/chat/);
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

test("weather request parser keeps Moscow district and evening intent separate", () => {
  assert.deepEqual(parseWeatherRequest("Сегодня в Митино вечером будет дождь?"), {
    location: "Москва",
    displayLocation: "Митино, Москва",
    target: "today",
    partOfDay: "evening",
  });
});

test("Open-Meteo weather capability answers Moscow district evening forecast", async () => {
  const capabilityRegistry = createCapabilityRegistry({
    fetchImpl: async (url) => {
      if (url.includes("geocoding-api.open-meteo.com")) {
        assert.match(url, /name=%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0/);
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                name: "Москва",
                admin1: "Москва",
                country: "Россия",
                latitude: 55.7512,
                longitude: 37.6184,
              },
            ],
          }),
        };
      }

      if (url.includes("api.open-meteo.com")) {
        assert.match(url, /hourly=/);
        return {
          ok: true,
          json: async () => ({
            daily: {
              time: ["2026-07-23", "2026-07-24", "2026-07-25"],
              weather_code: [61, 3, 2],
              temperature_2m_max: [24, 22, 25],
              temperature_2m_min: [16, 14, 15],
              precipitation_probability_max: [55, 20, 10],
              precipitation_sum: [0.8, 0, 0],
              wind_speed_10m_max: [10, 9, 8],
            },
            hourly: {
              time: [
                "2026-07-23T17:00",
                "2026-07-23T18:00",
                "2026-07-23T19:00",
                "2026-07-23T20:00",
                "2026-07-23T23:00",
              ],
              weather_code: [3, 61, 61, 3, 3],
              temperature_2m: [23, 22, 21, 20, 18],
              precipitation_probability: [20, 60, 55, 35, 10],
              precipitation: [0, 0.3, 0.2, 0, 0],
              wind_speed_10m: [7, 8, 9, 7, 5],
            },
          }),
        };
      }

      throw new Error(`unexpected url ${url}`);
    },
  });

  const result = await capabilityRegistry.run(
    "weather_forecast",
    parseWeatherRequest("Сегодня в Митино вечером будет дождь?"),
  );

  assert.equal(result.source, "weather_forecast");
  assert.match(result.text, /Митино, Москва/);
  assert.match(result.text, /вечером/);
  assert.match(result.text, /вероятность до 60%/);
  assert.doesNotMatch(result.text, /Не нашел город/);
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

test("repository backed orchestrator uses web_current_data before AI", async () => {
  const repositories = createInMemoryRepositories();
  const calls = [];
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry: {
      has(capabilityId) {
        return capabilityId === "web_current_data";
      },
      async run(capabilityId, args) {
        calls.push({ capabilityId, args });
        return {
          text: "Актуальный поиск: iPhone цена",
          source: "web_current_data",
          metadata: { provider: "test" },
        };
      },
    },
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for current data");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Какая актуальная цена iPhone?",
    telegramUpdateId: 799,
  });

  assert.equal(response.answer.source, "web_current_data");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capabilityId, "web_current_data");
});

test("repository backed orchestrator scopes current-data search to remembered site", async () => {
  const repositories = createInMemoryRepositories({
    memories: [
      {
        workspaceId: "workspace-family",
        ownerUserId: "owner-1",
        scope: "family",
        subjectType: "user_stated_fact",
        content: "https://rksurfmag.club/ \u043c\u043e\u0439 \u0436\u0443\u0440\u043d\u0430\u043b, \u044f \u0435\u0433\u043e \u0430\u0432\u0442\u043e\u0440 \u0438 \u0440\u0435\u0434\u0430\u043a\u0442\u043e\u0440",
      },
    ],
  });
  const calls = [];
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry: {
      has(capabilityId) {
        return capabilityId === "web_current_data";
      },
      async run(capabilityId, args) {
        calls.push({ capabilityId, args });
        return {
          text: "site-scoped results",
          source: "web_current_data",
          metadata: { provider: "test" },
        };
      },
    },
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for current data");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "\u043a\u0430\u043a\u0438\u0435 \u0432 \u043d\u0435\u043c \u043f\u043e\u0441\u043b\u0435\u0434\u043d\u0438\u0435 10 \u043d\u043e\u0432\u043e\u0441\u0442\u0435\u0439?",
    telegramUpdateId: 813,
  });

  assert.equal(response.answer.source, "web_current_data");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capabilityId, "web_current_data");
  assert.equal(calls[0].args.domain, "rksurfmag.club");
  assert.equal(calls[0].args.limit, 10);
});

test("public web search provider adds safe site scope when domain is supplied", async () => {
  const requestedUrls = [];
  const provider = createPublicWebSearchProvider({
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return new Response(
        [
          '<div class="result">',
          '<a class="result__a" href="https://rksurfmag.club/news">Latest</a>',
          '<a class="result__snippet">Snippet</a>',
          "</div>",
        ].join(""),
        {
          status: 200,
          headers: { "content-type": "text/html" },
        },
      );
    },
  });

  const result = await provider.search({
    query: "wingfoil school",
    domain: "https://www.rksurfmag.club/archive",
    limit: 10,
  });

  assert.equal(result.metadata.query, "site:rksurfmag.club wingfoil school");
  assert.equal(result.metadata.domain, "rksurfmag.club");
  assert.match(decodeURIComponent(requestedUrls[0]), /q=site:rksurfmag\.club wingfoil school/);
});

test("public web search provider reads domain WordPress posts for latest news", async () => {
  const requestedUrls = [];
  const provider = createPublicWebSearchProvider({
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      assert.match(String(url), /rksurfmag\.club\/wp-json\/wp\/v2\/posts/);
      return new Response(
        JSON.stringify([
          {
            date: "2026-07-22T10:00:00",
            link: "https://rksurfmag.club/news/one",
            title: { rendered: "Fresh wind report" },
            excerpt: { rendered: "<p>Short digest for riders.</p>" },
          },
          {
            date: "2026-07-21T11:00:00",
            link: "https://rksurfmag.club/news/two",
            title: { rendered: "New equipment test" },
            excerpt: { rendered: "<p>Boards and wings.</p>" },
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const result = await provider.search({
    query: "latest news",
    domain: "rksurfmag.club",
    limit: 10,
  });

  assert.equal(requestedUrls.length, 1);
  assert.equal(result.metadata.provider, "WordPress REST API");
  assert.equal(result.metadata.resultCount, 2);
  assert.match(result.text, /Fresh wind report/);
  assert.match(result.text, /New equipment test/);
});

test("public web search provider falls back to domain RSS feed for latest news", async () => {
  const requestedUrls = [];
  const provider = createPublicWebSearchProvider({
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));

      if (String(url).endsWith("/rss.xml")) {
        return new Response(
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            "<rss><channel>",
            "<item>",
            "<title>Latest kite event</title>",
            "<link>https://rksurfmag.club/latest-kite-event</link>",
            "<description><![CDATA[Short event digest.]]></description>",
            "<pubDate>Wed, 22 Jul 2026 10:00:00 +0300</pubDate>",
            "</item>",
            "<item>",
            "<title>Wingfoil gear review</title>",
            "<link>https://rksurfmag.club/wingfoil-gear-review</link>",
            "<description>New boards and wings.</description>",
            "<pubDate>Tue, 21 Jul 2026 11:00:00 +0300</pubDate>",
            "</item>",
            "</channel></rss>",
          ].join(""),
          {
            status: 200,
            headers: { "content-type": "application/rss+xml" },
          },
        );
      }

      return new Response("not found", { status: 404 });
    },
  });

  const result = await provider.search({
    query: "последние новости",
    domain: "rksurfmag.club",
    limit: 10,
  });

  assert.equal(requestedUrls[0], "https://rksurfmag.club/wp-json/wp/v2/posts?per_page=10&_fields=date,link,title,excerpt");
  assert.equal(requestedUrls[1], "https://rksurfmag.club/rss.xml");
  assert.equal(result.metadata.provider, "RSS/Atom feed");
  assert.equal(result.metadata.resultCount, 2);
  assert.match(result.text, /Latest kite event/);
  assert.match(result.text, /Wingfoil gear review/);
});

test("repository backed orchestrator routes news briefing to web_current_data", async () => {
  const repositories = createInMemoryRepositories();
  const calls = [];
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry: {
      has(capabilityId) {
        return capabilityId === "web_current_data" || capabilityId === "daily_briefing";
      },
      async run(capabilityId, args) {
        calls.push({ capabilityId, args });
        if (capabilityId === "daily_briefing") {
          throw new Error("News briefing should not use daily briefing");
        }
        return {
          text: "Новости: актуальная подборка",
          source: "web_current_data",
          metadata: { provider: "test" },
        };
      },
    },
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for news briefing");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Сделай утреннюю сводку по новостям",
    telegramUpdateId: 812,
  });

  assert.equal(response.answer.source, "web_current_data");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capabilityId, "web_current_data");
});

test("repository backed orchestrator creates local reminder before AI", async () => {
  const repositories = createInMemoryRepositories();
  const calls = [];
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry: {
      has(capabilityId) {
        return capabilityId === "tasks_reminders";
      },
      async run(capabilityId, args) {
        calls.push({ capabilityId, args });
        return {
          text: "Напоминание создано: купить лампы",
          source: "tasks_reminders",
          metadata: { reminderId: "reminder-1" },
        };
      },
    },
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for reminders");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "reminder",
    text: "Напомни завтра в 9 купить лампы",
    telegramUpdateId: 810,
  });

  assert.equal(response.answer.source, "tasks_reminders");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.chatId, 777);
});

test("repository backed orchestrator composes daily briefing before AI", async () => {
  const repositories = createInMemoryRepositories();
  const calls = [];
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry: {
      has(capabilityId) {
        return capabilityId === "daily_briefing";
      },
      async run(capabilityId, args) {
        calls.push({ capabilityId, args });
        return {
          text: "Ежедневная сводка: погода, напоминания, доступы",
          source: "daily_briefing",
        };
      },
    },
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for daily briefing");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Утренняя сводка с почтой и задачами",
    telegramUpdateId: 811,
  });

  assert.equal(response.answer.source, "daily_briefing");
  assert.equal(calls.length, 1);
});

test("repository backed orchestrator reads calendar capability before AI", async () => {
  const repositories = createInMemoryRepositories();
  const calls = [];
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry: {
      has(capabilityId) {
        return capabilityId === "calendar_scheduling";
      },
      async run(capabilityId, args) {
        calls.push({ capabilityId, args });
        return {
          text: "Календарь завтра:\n- 09:30: встреча\nИсточник: Google Calendar.",
          source: "calendar_scheduling",
        };
      },
    },
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for connected calendar requests");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Что у меня в календаре завтра?",
    telegramUpdateId: 813,
  });

  assert.equal(response.answer.source, "calendar_scheduling");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capabilityId, "calendar_scheduling");
  assert.equal(calls[0].args.actor.role, "owner");
});

test("repository backed orchestrator reads email capability before AI", async () => {
  const repositories = createInMemoryRepositories();
  const calls = [];
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry: {
      has(capabilityId) {
        return capabilityId === "email_triage";
      },
      async run(capabilityId, args) {
        calls.push({ capabilityId, args });
        return {
          text: "Почта Gmail: последние письма:\n- school@example.com: расписание",
          source: "email_triage",
        };
      },
    },
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for connected email requests");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Покажи непрочитанные письма из почты",
    telegramUpdateId: 814,
  });

  assert.equal(response.answer.source, "email_triage");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capabilityId, "email_triage");
  assert.equal(calls[0].args.actor.role, "owner");
});

test("repository backed orchestrator lists expanded capability registry", async () => {
  const repositories = createInMemoryRepositories();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry: createCapabilityRegistry({
      fetchImpl: async () => {
        throw new Error("fetch should not be called when listing capabilities");
      },
      materialsRepositoryAvailable: true,
      telegramConfigured: true,
    }),
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for capabilities list");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "/tools",
    telegramUpdateId: 800,
  });

  assert.equal(response.answer.source, "capability_list");
  assert.match(response.answer.text, /weather_forecast/);
  assert.match(response.answer.text, /web_fetch_url/);
  assert.match(response.answer.text, /time_location_context/);
  assert.match(response.answer.text, /calendar_scheduling/);
  assert.match(response.answer.text, /подключен/);
  assert.match(response.answer.text, /нужен доступ/);
});

test("repository backed orchestrator falls back to wttr weather when Open-Meteo fails", async () => {
  const repositories = createInMemoryRepositories();
  const calls = [];
  const capabilityRegistry = createCapabilityRegistry({
    fetchImpl: async (url) => {
      calls.push(url);

      if (url.includes("open-meteo")) {
        return {
          ok: false,
          status: 503,
          json: async () => ({}),
        };
      }

      if (url.includes("wttr.in")) {
        return {
          ok: true,
          json: async () => ({
            current_condition: [{ weatherCode: "0" }],
            weather: [
              {
                date: "2026-07-25",
                maxtempC: "25",
                mintempC: "16",
                totalSnow_cm: "0",
                hourly: [{}, {}, {}, {}, {
                  weatherCode: "0",
                  chanceofrain: "10",
                  windspeedKmph: "11",
                }],
              },
              {
                date: "2026-07-26",
                maxtempC: "26",
                mintempC: "17",
                totalSnow_cm: "0",
                hourly: [{}, {}, {}, {}, {
                  weatherCode: "1",
                  chanceofrain: "20",
                  windspeedKmph: "12",
                }],
              },
            ],
          }),
        };
      }

      throw new Error(`unexpected url ${url}`);
    },
  });
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called when weather fallback works");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Какая погода в Москве на выходных?",
    telegramUpdateId: 801,
  });

  assert.equal(response.answer.source, "weather_forecast");
  assert.match(response.answer.text, /wttr\.in/);
  assert.equal(calls.some((url) => url.includes("open-meteo")), true);
  assert.equal(calls.some((url) => url.includes("wttr.in")), true);
});

test("repository backed orchestrator uses web_fetch_url for explicit links", async () => {
  const repositories = createInMemoryRepositories();
  const capabilityRegistry = createCapabilityRegistry({
    dnsLookup: async () => [{ address: "93.184.216.34" }],
    fetchImpl: async (url) => {
      assert.equal(url, "https://example.com/page");
      return {
        ok: true,
        headers: {
          get(name) {
            return name === "content-type" ? "text/html; charset=utf-8" : null;
          },
        },
        text: async () => "<html><title>Example page</title><body><h1>Hello family AI</h1></body></html>",
      };
    },
  });
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for explicit URL fetch");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Прочитай ссылку https://example.com/page",
    telegramUpdateId: 802,
  });

  assert.equal(response.answer.source, "web_fetch_url");
  assert.match(response.answer.text, /Example page/);
  assert.match(response.answer.text, /Hello family AI/);
});

test("repository backed orchestrator blocks local URL fetches", async () => {
  const repositories = createInMemoryRepositories();
  const capabilityRegistry = createCapabilityRegistry({
    fetchImpl: async () => {
      throw new Error("fetch should not be called for blocked local URLs");
    },
  });
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for blocked URL fetch");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Прочитай ссылку http://127.0.0.1:8080/admin",
    telegramUpdateId: 805,
  });

  assert.equal(response.answer.source, "web_fetch_url");
  assert.match(response.answer.text, /не читаю локальные/i);
});

test("repository backed orchestrator blocks URL fetch redirects to local addresses", async () => {
  const repositories = createInMemoryRepositories();
  const capabilityRegistry = createCapabilityRegistry({
    dnsLookup: async (hostname) => {
      assert.equal(hostname, "example.com");
      return [{ address: "93.184.216.34" }];
    },
    fetchImpl: async (url) => {
      assert.equal(url, "https://example.com/redirect");
      return {
        ok: false,
        status: 302,
        headers: {
          get(name) {
            return name === "location" ? "http://127.0.0.1:8080/admin" : null;
          },
        },
      };
    },
  });
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for blocked redirect");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Прочитай ссылку https://example.com/redirect",
    telegramUpdateId: 806,
  });

  assert.equal(response.answer.source, "web_fetch_url");
  assert.match(response.answer.text, /не читаю локальные/i);
});

test("repository backed orchestrator blocks IPv6 mapped local URL fetches", async () => {
  const repositories = createInMemoryRepositories();
  const capabilityRegistry = createCapabilityRegistry({
    fetchImpl: async () => {
      throw new Error("fetch should not be called for blocked IPv6 local URLs");
    },
  });
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for blocked IPv6 URL fetch");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Прочитай ссылку http://[::ffff:127.0.0.1]/admin",
    telegramUpdateId: 807,
  });

  assert.equal(response.answer.source, "web_fetch_url");
  assert.match(response.answer.text, /не читаю локальные/i);
});

test("repository backed orchestrator blocks public hostnames that resolve to private IPv6", async () => {
  const repositories = createInMemoryRepositories();
  const capabilityRegistry = createCapabilityRegistry({
    dnsLookup: async () => [{ address: "fe80::1" }],
    fetchImpl: async () => {
      throw new Error("fetch should not be called for hostnames resolving to private IPv6");
    },
  });
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for blocked DNS resolution");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Прочитай ссылку https://example.com/private",
    telegramUpdateId: 808,
  });

  assert.equal(response.answer.source, "web_fetch_url");
  assert.match(response.answer.text, /не читаю локальные/i);
});

test("repository backed orchestrator uses time_location_context before AI", async () => {
  const repositories = createInMemoryRepositories();
  const capabilityRegistry = createCapabilityRegistry({
    clock: () => new Date("2026-07-21T14:00:00.000Z"),
  });
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for time context");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Который час в Москве и когда ближайшие выходные?",
    telegramUpdateId: 803,
  });

  assert.equal(response.answer.source, "time_location_context");
  assert.match(response.answer.text, /Europe\/Moscow/);
  assert.match(response.answer.text, /выходные/i);
});

test("repository backed orchestrator returns missing calendar capability without OAuth", async () => {
  const repositories = createInMemoryRepositories();
  const capabilityRegistry = createCapabilityRegistry();
  const orchestrator = createRepositoryBackedOrchestrator({
    repositories,
    capabilityRegistry,
    aiProvider: {
      async complete() {
        throw new Error("AI should not be called for calendar requests without OAuth");
      },
    },
  });

  const response = await orchestrator({
    chatId: 777,
    actor: { id: "owner-1", role: "owner" },
    intent: "household",
    text: "Что у меня в календаре завтра?",
    telegramUpdateId: 804,
  });

  assert.equal(response.answer.source, "capability_missing");
  assert.match(response.answer.text, /calendar_scheduling/);
});
