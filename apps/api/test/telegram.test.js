import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramRequest,
  handleTelegramUpdate,
  inferIntentFromText,
  resolveTelegramActor,
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

test("resolveTelegramActor returns null for unknown telegram user", () => {
  const actor = resolveTelegramActor({ from: { id: 999 } }, users);

  assert.equal(actor, null);
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
    { users },
  );

  assert.equal(request.chatId, 777);
  assert.equal(request.actor.id, "owner-1");
  assert.equal(request.intent, "gazebo_design");
  assert.equal(request.text, "Посчитай материалы для беседки");
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
