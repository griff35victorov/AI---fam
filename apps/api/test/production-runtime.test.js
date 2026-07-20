import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryRepositories } from "../../../packages/db/src/index.js";
import { createAppServerFromEnv } from "../src/server.js";
import { createProductionDependencies } from "../src/production-runtime.js";

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

async function withServer(server, run) {
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

test("production dependencies wire Timeweb AI and Telegram sender from env", async () => {
  const calls = [];
  const dependencies = createProductionDependencies({
    env: {
      APP_DEFAULT_WORKSPACE_ID: "workspace-prod",
      TIMEWEB_AI_API_KEY: "timeweb-key",
      TIMEWEB_AI_BASE_URL: "https://timeweb.example",
      TIMEWEB_AGENT_IDS: JSON.stringify({
        owner_assistant: "agent-owner",
      }),
      TELEGRAM_BOT_TOKEN: "telegram-token",
    },
    repositories: createInMemoryRepositories(),
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({ text: "ok" });
    },
  });

  assert.equal(dependencies.workspaceId, "workspace-prod");

  await dependencies.aiProvider.complete({
    agentProfile: "owner_assistant",
    modelProfile: { model: "tw-model" },
    messages: [{ role: "user", content: "hello" }],
  });
  await dependencies.telegramSender.sendMessage({
    chatId: 777,
    text: "hello back",
  });

  assert.equal(
    calls[0][0],
    "https://timeweb.example/api/v1/cloud-ai/agents/agent-owner/call",
  );
  assert.equal(calls[0][1].headers.authorization, "Bearer timeweb-key");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    messages: [{ role: "user", content: "hello" }],
    model: "tw-model",
  });

  assert.equal(
    calls[1][0],
    "https://api.telegram.org/bottelegram-token/sendMessage",
  );
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    chat_id: 777,
    text: "hello back",
  });
});

test("production dependencies also read individual Timeweb agent id env vars", async () => {
  const calls = [];
  const dependencies = createProductionDependencies({
    env: {
      TIMEWEB_AI_API_KEY: "timeweb-key",
      TIMEWEB_AGENT_DESIGN_ASSISTANT: "agent-design",
      TELEGRAM_FAMILY_BOT_TOKEN: "telegram-token",
    },
    repositories: createInMemoryRepositories(),
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({ text: "ok" });
    },
  });

  await dependencies.aiProvider.complete({
    agentProfile: "design_assistant",
    modelProfile: { model: "tw-strong" },
    messages: [],
  });

  assert.equal(
    calls[0][0],
    "https://api.timeweb.cloud/api/v1/cloud-ai/agents/agent-design/call",
  );
});

test("production dependencies ignore empty env overrides", async () => {
  const calls = [];
  const dependencies = createProductionDependencies({
    env: {
      TIMEWEB_AI_API_KEY: "timeweb-key",
      TIMEWEB_AI_BASE_URL: "",
      TIMEWEB_AGENT_IDS: JSON.stringify({
        owner_assistant: "agent-owner",
      }),
      TIMEWEB_AGENT_OWNER_ASSISTANT: "",
      TELEGRAM_BOT_TOKEN: "telegram-token",
    },
    repositories: createInMemoryRepositories(),
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({ text: "ok" });
    },
  });

  await dependencies.aiProvider.complete({
    agentProfile: "owner_assistant",
    modelProfile: { model: "tw-model" },
    messages: [],
  });

  assert.equal(
    calls[0][0],
    "https://api.timeweb.cloud/api/v1/cloud-ai/agents/agent-owner/call",
  );
});

test("server env factory uses production dependencies for Telegram webhook", async () => {
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
  const calls = [];
  const server = createAppServerFromEnv({
    env: {
      TIMEWEB_AI_API_KEY: "timeweb-key",
      TIMEWEB_AGENT_OWNER_ASSISTANT: "agent-owner",
      TELEGRAM_BOT_TOKEN: "telegram-token",
    },
    repositories,
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({ text: "Production answer" });
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/telegram/webhook`, {
      update_id: 900,
      message: {
        chat: { id: 777 },
        from: { id: 100 },
        text: "hello",
      },
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).text, "Production answer");
  });

  assert.equal(
    calls[0][0],
    "https://api.timeweb.cloud/api/v1/cloud-ai/agents/agent-owner/call",
  );
  assert.equal(
    calls[1][0],
    "https://api.telegram.org/bottelegram-token/sendMessage",
  );
});
