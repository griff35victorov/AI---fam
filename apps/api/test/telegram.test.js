import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryRepositories } from "../../../packages/db/src/index.js";
import {
  buildTelegramRequest,
  buildTelegramRequestFromRepositories,
  handleTelegramUpdate,
  inferIntentFromText,
  resolveTelegramActor,
  telegramBotAcceptsActor,
} from "../src/telegram.js";

const users = [
  { id: "owner-1", role: "owner", telegramUserId: "100" },
  { id: "teacher-1", role: "teacher", telegramUserId: "200" },
  { id: "child-1", role: "family_child", telegramUserId: "300" },
];

test("resolveTelegramActor maps known telegram user to local actor", () => {
  const actor = resolveTelegramActor({ from: { id: 200 } }, users);

  assert.deepEqual(actor, { id: "teacher-1", role: "teacher" });
});

test("buildTelegramRequestFromRepositories transcribes voice before routing", async () => {
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

  const request = await buildTelegramRequestFromRepositories(
    {
      update_id: 555,
      message: {
        chat: { id: 777 },
        from: { id: 100 },
        voice: { file_id: "voice-file", duration: 4 },
      },
    },
    {
      repositories,
      voiceTranscriber: {
        async transcribeTelegramVoice({ fileId }) {
          assert.equal(fileId, "voice-file");
          return { ok: true, text: "Посчитай 2 плюс 2" };
        },
      },
    },
  );

  assert.equal(request.text, "Посчитай 2 плюс 2");
  assert.equal(request.intent, "calculation");
  assert.equal(request.voiceTranscribed, true);
});

test("handleTelegramUpdate rejects voice before orchestrator when STT is not configured", async () => {
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
  const sent = [];

  const response = await handleTelegramUpdate(
    {
      update_id: 556,
      message: {
        chat: { id: 777 },
        from: { id: 100 },
        voice: { file_id: "voice-file", duration: 4 },
      },
    },
    {
      repositories,
      orchestrator: async () => {
        throw new Error("orchestrator should not receive untranscribed voice");
      },
      telegramSender: {
        async sendMessage(message) {
          sent.push(message);
        },
      },
    },
  );

  assert.match(response.text, /Голосовой ввод пока не настроен/);
  assert.equal(sent.length, 1);
});

test("buildTelegramRequestFromRepositories recognizes photo text before routing", async () => {
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

  const request = await buildTelegramRequestFromRepositories(
    {
      update_id: 557,
      message: {
        chat: { id: 777 },
        from: { id: 100 },
        caption: "Распознай текст",
        photo: [
          { file_id: "small-photo", file_size: 10 },
          { file_id: "large-photo", file_size: 100 },
        ],
      },
    },
    {
      repositories,
      imageOcr: {
        async recognizeTelegramImage({ fileId }) {
          assert.equal(fileId, "large-photo");
          return { ok: true, text: "Домашнее задание: exercise 4" };
        },
      },
    },
  );

  assert.equal(request.imageRecognized, true);
  assert.match(request.text, /Распознай текст/);
  assert.match(request.text, /Домашнее задание/);
});

test("buildTelegramRequestFromRepositories extracts text document for learn material command", async () => {
  const repositories = createInMemoryRepositories({
    users: [
      {
        id: "teacher-1",
        role: "teacher",
        telegramUserId: "200",
        workspaceId: "workspace-family",
      },
    ],
  });

  const request = await buildTelegramRequestFromRepositories(
    {
      update_id: 559,
      message: {
        chat: { id: 778 },
        from: { id: 200 },
        caption: "/learn material Irregular verbs drill",
        document: {
          file_id: "document-file",
          file_name: "verbs.md",
          mime_type: "text/markdown",
          file_size: 120,
        },
      },
    },
    {
      repositories,
      documentTextExtractor: {
        async extractTelegramDocument({ fileId, fileName }) {
          assert.equal(fileId, "document-file");
          assert.equal(fileName, "verbs.md");
          return { ok: true, text: "go-went-gone\nsee-saw-seen" };
        },
      },
    },
  );

  assert.equal(request.documentExtracted, true);
  assert.match(request.text, /\/learn material Irregular verbs drill/);
  assert.match(request.text, /go-went-gone/);
});

test("handleTelegramUpdate rejects photo before orchestrator when OCR is not configured", async () => {
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
  const sent = [];

  const response = await handleTelegramUpdate(
    {
      update_id: 558,
      message: {
        chat: { id: 777 },
        from: { id: 100 },
        photo: [{ file_id: "photo-file", file_size: 100 }],
      },
    },
    {
      repositories,
      orchestrator: async () => {
        throw new Error("orchestrator should not receive unrecognized photo");
      },
      telegramSender: {
        async sendMessage(message) {
          sent.push(message);
        },
      },
    },
  );

  assert.match(response.text, /Распознавание фото пока не настроено/);
  assert.equal(sent.length, 1);
});

test("resolveTelegramActor returns null for unknown telegram user", () => {
  const actor = resolveTelegramActor({ from: { id: 999 } }, users);

  assert.equal(actor, null);
});

test("telegramBotAcceptsActor enforces dedicated family bot roles", () => {
  assert.equal(telegramBotAcceptsActor("owner", { role: "owner" }), true);
  assert.equal(telegramBotAcceptsActor("daughter", { role: "family_child" }), true);
  assert.equal(telegramBotAcceptsActor("teacher", { role: "teacher" }), true);
  assert.equal(telegramBotAcceptsActor("daughter", { role: "teacher" }), false);
  assert.equal(telegramBotAcceptsActor(undefined, { role: "teacher" }), true);
});

test("inferIntentFromText uses role and text to choose first route", () => {
  assert.equal(inferIntentFromText({ role: "owner" }, "Сделай дизайн беседки 3 на 4"), "gazebo_design");
  assert.equal(inferIntentFromText({ role: "teacher" }, "Подготовь урок для B1"), "lesson_preparation");
  assert.equal(inferIntentFromText({ role: "family_child" }, "Потренируем английский"), "english_practice");
  assert.equal(inferIntentFromText({ role: "owner" }, "Напомни купить лампы"), "reminder");
});

test("buildTelegramRequest creates orchestrator request from message update", () => {
  const request = buildTelegramRequest(
    {
      message: {
        chat: { id: 777 },
        from: { id: 100 },
        text: "Посчитай материалы для беседки",
      },
    },
    { users, botKey: "owner" },
  );

  assert.equal(request.chatId, 777);
  assert.equal(request.actor.id, "owner-1");
  assert.equal(request.intent, "gazebo_design");
  assert.equal(request.telegramBotKey, "owner");
  assert.equal(request.text, "Посчитай материалы для беседки");
});

test("buildTelegramRequest rejects users in the wrong dedicated bot", () => {
  const request = buildTelegramRequest(
    {
      message: {
        chat: { id: 777 },
        from: { id: 200 },
        text: "lesson",
      },
    },
    { users, botKey: "daughter" },
  );

  assert.equal(request.rejected, true);
  assert.equal(request.reason, "telegram_bot_role_mismatch");
});

test("handleTelegramUpdate rejects unknown telegram users", async () => {
  const response = await handleTelegramUpdate(
    { message: { chat: { id: 777 }, from: { id: 999 }, text: "Привет" } },
    {
      users,
      orchestrator: async () => {
        throw new Error("orchestrator should not be called");
      },
    },
  );

  assert.deepEqual(response, {
    chatId: 777,
    text: "Доступ не настроен. Обратитесь к владельцу семейного оркестратора.",
  });
});

test("handleTelegramUpdate answers /start without calling orchestrator", async () => {
  let orchestratorCalled = false;
  const response = await handleTelegramUpdate(
    { message: { chat: { id: 777 }, from: { id: 100 }, text: "/start" } },
    {
      users,
      orchestrator: async () => {
        orchestratorCalled = true;
        return { answer: { text: "should not happen" } };
      },
    },
  );

  assert.equal(orchestratorCalled, false);
  assert.equal(response.chatId, 777);
  assert.match(response.text, /Бот подключен/);
});

test("handleTelegramUpdate sends known user request to orchestrator", async () => {
  const calls = [];
  const response = await handleTelegramUpdate(
    {
      message: {
        chat: { id: 777 },
        from: { id: 200 },
        text: "Подготовь урок B1",
      },
    },
    {
      users,
      orchestrator: async (request) => {
        calls.push(request);
        return { answer: { text: "План урока готов" } };
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].actor.role, "teacher");
  assert.equal(calls[0].intent, "lesson_preparation");
  assert.deepEqual(response, { chatId: 777, text: "План урока готов" });
});
