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
