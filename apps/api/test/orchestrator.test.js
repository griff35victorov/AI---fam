import assert from "node:assert/strict";
import test from "node:test";

import { handleOrchestratorRequest } from "../src/orchestrator.js";

test("orchestrator routes owner gazebo request to design assistant", async () => {
  const response = await handleOrchestratorRequest({
    actor: { id: "owner-1", role: "owner" },
    intent: "gazebo_design",
    text: "Сделай концепт беседки 3 на 4",
  });

  assert.equal(response.agentProfile, "design_assistant");
  assert.equal(response.requiresConfirmation, false);
});

test("orchestrator marks external messages as confirmation required", async () => {
  const response = await handleOrchestratorRequest({
    actor: { id: "teacher-1", role: "teacher" },
    intent: "message_draft",
    action: "send_external_message",
    text: "Напиши ученику напоминание",
  });

  assert.equal(response.agentProfile, "communication_assistant");
  assert.equal(response.requiresConfirmation, true);
});

test("orchestrator calls AI provider with allowed memory context and model profile", async () => {
  const calls = [];
  const aiProvider = {
    async complete(payload) {
      calls.push(payload);
      return { text: "Draft lesson plan" };
    },
  };

  const response = await handleOrchestratorRequest(
    {
      actor: { id: "teacher-1", role: "teacher" },
      intent: "lesson_preparation",
      text: "Подготовь урок B1 по Past Perfect",
      memories: [
        {
          scope: "teacher_private",
          sensitivity: "normal",
          subjectType: "teaching_style",
          content: "Use short warmups and controlled practice.",
        },
        {
          scope: "family",
          sensitivity: "secret",
          subjectType: "credential",
          content: "Do not leak this token.",
        },
      ],
    },
    { aiProvider },
  );

  assert.equal(response.agentProfile, "teacher_methodologist");
  assert.equal(response.modelProfile.profile, "standard");
  assert.equal(response.answer.text, "Draft lesson plan");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentProfile, "teacher_methodologist");
  assert.match(calls[0].messages[0].content, /Use short warmups/);
  assert.doesNotMatch(calls[0].messages[0].content, /token/);
});

test("orchestrator answers common status questions without calling AI", async () => {
  const response = await handleOrchestratorRequest(
    {
      actor: { id: "owner-1", role: "owner" },
      intent: "household",
      text: "Что ты умеешь?",
    },
    {
      aiProvider: {
        async complete() {
          throw new Error("AI should not be called for a fast answer");
        },
      },
    },
  );

  assert.equal(response.accepted, true);
  assert.equal(response.answer.source, "local_fast_reply");
  assert.match(response.answer.text, /могу/i);
});

test("orchestrator answers voice input questions without calling AI", async () => {
  const response = await handleOrchestratorRequest(
    {
      actor: { id: "owner-1", role: "owner" },
      intent: "household",
      text: "ты воспринимаешь голосовой ввод?",
    },
    {
      aiProvider: {
        async complete() {
          throw new Error("AI should not be called for a fast answer");
        },
      },
    },
  );

  assert.equal(response.answer.source, "local_fast_reply");
  assert.match(response.answer.text, /голос/i);
});
