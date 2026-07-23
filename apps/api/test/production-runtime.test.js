import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryRepositories } from "../../../packages/db/src/index.js";
import { createAppServerFromEnv, createAppServerFromEnvAsync } from "../src/server.js";
import {
  createProductionDependencies,
  createTelegramSenders,
  parseTelegramWebhookSecrets,
} from "../src/production-runtime.js";

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
    "https://timeweb.example/api/v1/cloud-ai/agents/agent-owner/v1/chat/completions",
  );
  assert.equal(calls[0][1].headers.authorization, "Bearer timeweb-key");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    model: "tw-model",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
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

test("production dependencies expose configured web chat url", () => {
  const explicit = createProductionDependencies({
    env: {
      WEB_CHAT_ACCESS_CODE: "family-web-code",
      WEB_CHAT_URL: "https://family.example/custom-chat",
    },
    repositories: createInMemoryRepositories(),
  });
  assert.equal(explicit.webChatAccessCode, "family-web-code");
  assert.equal(explicit.webChatUrl, "https://family.example/custom-chat");

  const fromAppUrl = createProductionDependencies({
    env: {
      TIMEWEB_APP_URL: "https://family.example",
    },
    repositories: createInMemoryRepositories(),
  });
  assert.equal(fromAppUrl.webChatUrl, "https://family.example/chat");
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
    "https://agent.timeweb.cloud/api/v1/cloud-ai/agents/agent-design/v1/chat/completions",
  );
});

test("production dependencies create dedicated Telegram bot senders and secrets", async () => {
  const dependencies = createProductionDependencies({
    env: {
      TELEGRAM_OWNER_BOT_TOKEN: "owner-token",
      TELEGRAM_DAUGHTER_BOT_TOKEN: "daughter-token",
      TELEGRAM_TEACHER_BOT_TOKEN: "teacher-token",
      TELEGRAM_OWNER_WEBHOOK_SECRET: "owner-secret",
      TELEGRAM_DAUGHTER_WEBHOOK_SECRET: "daughter-secret",
      TELEGRAM_TEACHER_WEBHOOK_SECRET: "teacher-secret",
    },
    repositories: createInMemoryRepositories(),
    fetchImpl: async () => jsonResponse({ ok: true, result: true }),
  });

  assert.deepEqual(Object.keys(dependencies.telegramSenders).sort(), [
    "daughter",
    "owner",
    "teacher",
  ]);
  assert.deepEqual(Object.keys(dependencies.documentTextExtractors).sort(), [
    "daughter",
    "owner",
    "teacher",
  ]);
  assert.deepEqual(dependencies.telegramWebhookSecrets, {
    owner: "owner-secret",
    daughter: "daughter-secret",
    teacher: "teacher-secret",
  });
  assert.equal(dependencies.telegramPollingEnabled, false);
  assert.deepEqual(Object.keys(dependencies.telegramPollingBotTokens).sort(), [
    "daughter",
    "owner",
    "teacher",
  ]);
});

test("production dependencies enable Telegram polling by default in production when bot tokens exist", () => {
  const dependencies = createProductionDependencies({
    env: {
      NODE_ENV: "production",
      TELEGRAM_OWNER_BOT_TOKEN: "owner-token",
    },
    repositories: createInMemoryRepositories(),
  });

  assert.equal(dependencies.telegramPollingEnabled, true);
  assert.equal(dependencies.telegramPollingClearWebhookEnabled, true);
  assert.equal(dependencies.telegramUpdateQueueEnabled, true);
  assert.equal(dependencies.telegramWebhookIngressMode, "direct_or_relay");
  assert.equal(dependencies.telegramUpdateDispatcherIntervalMs, 1000);
  assert.equal(dependencies.telegramUpdateDispatcherMaxJobs, 10);
  assert.equal(dependencies.telegramUpdateDispatcherMaxAttempts, 3);
  assert.equal(dependencies.telegramUpdateDispatcherRetryDelayMs, 5000);
  assert.equal(dependencies.telegramAcceptedAckThrottleMs, 8000);
  assert.equal(dependencies.supervisorEnabled, true);
  assert.equal(dependencies.supervisorIntervalMs, 60_000);
  assert.equal(dependencies.supervisorAlertCooldownMs, 600_000);
  assert.equal(dependencies.supervisorAutoHeal, true);
  assert.equal(dependencies.supervisorHealFailedTelegramUpdates, true);
  assert.equal(dependencies.supervisorAuditOkTicks, false);
  assert.equal(dependencies.supervisorAuditDedupMs, 600_000);
  assert.deepEqual(dependencies.telegramPollingBotTokens, { owner: "owner-token" });
});

test("production dependencies keep polling disabled by default when relay ingress is configured", () => {
  const dependencies = createProductionDependencies({
    env: {
      NODE_ENV: "production",
      TELEGRAM_OWNER_BOT_TOKEN: "owner-token",
      TELEGRAM_RELAY_URL: "https://relay.example",
      TELEGRAM_RELAY_SECRET: "relay-secret",
      TELEGRAM_POLLING_ENABLED: "true",
    },
    repositories: createInMemoryRepositories(),
  });

  assert.equal(dependencies.telegramWebhookIngressMode, "relay");
  assert.equal(dependencies.telegramPollingEnabled, false);
  assert.equal(dependencies.telegramPollingClearWebhookEnabled, false);
});

test("production dependencies allow polling with relay only in emergency mode", () => {
  const dependencies = createProductionDependencies({
    env: {
      NODE_ENV: "production",
      TELEGRAM_OWNER_BOT_TOKEN: "owner-token",
      TELEGRAM_RELAY_URL: "https://relay.example",
      TELEGRAM_RELAY_SECRET: "relay-secret",
      TELEGRAM_POLLING_ENABLED: "true",
      TELEGRAM_POLLING_EMERGENCY_ENABLED: "true",
    },
    repositories: createInMemoryRepositories(),
  });

  assert.equal(dependencies.telegramWebhookIngressMode, "relay");
  assert.equal(dependencies.telegramPollingEnabled, true);
});

test("production dependencies can disable failed Telegram update healing", () => {
  const dependencies = createProductionDependencies({
    env: {
      NODE_ENV: "production",
      TELEGRAM_OWNER_BOT_TOKEN: "owner-token",
      SUPERVISOR_HEAL_FAILED_TELEGRAM_UPDATES: "false",
    },
    repositories: createInMemoryRepositories(),
  });

  assert.equal(dependencies.supervisorHealFailedTelegramUpdates, false);
});

test("production dependencies allow direct Telegram ingress even when relay upstream secret is configured", () => {
  const dependencies = createProductionDependencies({
    env: {
      NODE_ENV: "production",
      TELEGRAM_OWNER_BOT_TOKEN: "owner-token",
      TELEGRAM_RELAY_UPSTREAM_SECRET: "relay-upstream-secret",
    },
    repositories: createInMemoryRepositories(),
  });

  assert.equal(dependencies.telegramWebhookIngressMode, "direct_or_relay");
});

test("production dependencies still support explicit relay-only Telegram ingress", () => {
  const dependencies = createProductionDependencies({
    env: {
      NODE_ENV: "production",
      TELEGRAM_OWNER_BOT_TOKEN: "owner-token",
      TELEGRAM_RELAY_UPSTREAM_SECRET: "relay-upstream-secret",
      TELEGRAM_WEBHOOK_INGRESS: "relay",
    },
    repositories: createInMemoryRepositories(),
  });

  assert.equal(dependencies.telegramWebhookIngressMode, "relay");
});

test("production dependencies disable durable queue defaults without repositories", () => {
  const dependencies = createProductionDependencies({
    env: {
      NODE_ENV: "production",
      TELEGRAM_OWNER_BOT_TOKEN: "owner-token",
    },
  });

  assert.equal(dependencies.telegramUpdateQueueEnabled, false);
  assert.equal(dependencies.supervisorEnabled, false);
});

test("production dependencies can explicitly disable Telegram polling", () => {
  const dependencies = createProductionDependencies({
    env: {
      NODE_ENV: "production",
      TELEGRAM_POLLING_ENABLED: "false",
      TELEGRAM_OWNER_BOT_TOKEN: "owner-token",
    },
    repositories: createInMemoryRepositories(),
  });

  assert.equal(dependencies.telegramPollingEnabled, false);
  assert.deepEqual(dependencies.telegramPollingBotTokens, { owner: "owner-token" });
});

test("production dependencies can explicitly keep Telegram webhook while polling is disabled", () => {
  const dependencies = createProductionDependencies({
    env: {
      NODE_ENV: "production",
      TELEGRAM_OWNER_BOT_TOKEN: "owner-token",
      TELEGRAM_POLLING_ENABLED: "false",
      TELEGRAM_POLLING_CLEAR_WEBHOOK_ENABLED: "false",
    },
    repositories: createInMemoryRepositories(),
  });

  assert.equal(dependencies.telegramPollingEnabled, false);
  assert.equal(dependencies.telegramPollingClearWebhookEnabled, false);
});

test("production dependencies create background relay senders when relay is configured", async () => {
  const calls = [];
  const dependencies = createProductionDependencies({
    env: {
      TELEGRAM_RELAY_URL: "https://relay.example/",
      TELEGRAM_RELAY_SECRET: "relay-secret",
    },
    repositories: createInMemoryRepositories(),
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({ ok: true, result: { message_id: 46 } });
    },
  });

  assert.deepEqual(Object.keys(dependencies.telegramBackgroundSenders).sort(), [
    "daughter",
    "owner",
    "teacher",
  ]);

  await dependencies.telegramBackgroundSenders.teacher.sendMessage({
    chatId: 777,
    text: "Teacher async answer",
  });

  assert.equal(calls[0][0], "https://relay.example/telegram/teacher/send");
  assert.equal(calls[0][1].headers["x-family-ai-relay-secret"], "relay-secret");
});

test("production dependencies fail closed without relay background senders", () => {
  const dependencies = createProductionDependencies({
    env: {
      NODE_ENV: "production",
      TELEGRAM_TEACHER_BOT_TOKEN: "teacher-token",
    },
    repositories: createInMemoryRepositories(),
  });

  assert.deepEqual(dependencies.telegramBackgroundSenders, {});
});

test("production dependencies allow direct background senders only with explicit override", async () => {
  const calls = [];
  const dependencies = createProductionDependencies({
    env: {
      NODE_ENV: "production",
      TELEGRAM_TEACHER_BOT_TOKEN: "teacher-token",
      TELEGRAM_BACKGROUND_SEND_MODE: "direct",
      TELEGRAM_ALLOW_DIRECT_BACKGROUND_SEND: "true",
    },
    repositories: createInMemoryRepositories(),
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({ ok: true, result: { message_id: 49 } });
    },
  });

  assert.deepEqual(Object.keys(dependencies.telegramBackgroundSenders), ["teacher"]);

  await dependencies.telegramBackgroundSenders.teacher.sendMessage({
    chatId: 777,
    text: "Direct debug answer",
  });

  assert.equal(calls[0][0], "https://api.telegram.org/botteacher-token/sendMessage");
});

test("production dependencies prefer relay background senders when relay is configured", async () => {
  const calls = [];
  const dependencies = createProductionDependencies({
    env: {
      TELEGRAM_RELAY_URL: "https://relay.example/",
      TELEGRAM_RELAY_SECRET: "relay-secret",
      TELEGRAM_TEACHER_BOT_TOKEN: "teacher-token",
    },
    repositories: createInMemoryRepositories(),
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({ ok: true, result: { message_id: 47 } });
    },
  });

  assert.deepEqual(Object.keys(dependencies.telegramBackgroundSenders).sort(), [
    "daughter",
    "owner",
    "teacher",
  ]);

  await dependencies.telegramBackgroundSenders.teacher.sendMessage({
    chatId: 777,
    text: "Teacher async answer https://example.com",
  });

  assert.equal(calls[0][0], "https://relay.example/telegram/teacher/send");
  assert.deepEqual(JSON.parse(calls[0][1].body).link_preview_options, {
    is_disabled: true,
  });
});

test("production Telegram background senders can fall back to relay in explicit failover mode", async () => {
  const calls = [];
  const dependencies = createProductionDependencies({
    env: {
      TELEGRAM_RELAY_URL: "https://relay.example/",
      TELEGRAM_RELAY_SECRET: "relay-secret",
      TELEGRAM_TEACHER_BOT_TOKEN: "teacher-token",
      TELEGRAM_BACKGROUND_SEND_MODE: "failover",
    },
    repositories: createInMemoryRepositories(),
    fetchImpl: async (...args) => {
      calls.push(args);
      if (String(args[0]).includes("api.telegram.org")) {
        throw new TypeError("fetch failed");
      }

      return jsonResponse({ ok: true, result: { message_id: 48 } });
    },
  });

  const result = await dependencies.telegramBackgroundSenders.teacher.sendMessage({
    chatId: 777,
    text: "Teacher async answer",
  });

  assert.deepEqual(result, { ok: true, result: { message_id: 48 } });
  assert.equal(calls[0][0], "https://api.telegram.org/botteacher-token/sendMessage");
  assert.equal(calls[1][0], "https://relay.example/telegram/teacher/send");
});

test("createTelegramSenders and parseTelegramWebhookSecrets ignore missing bot env", () => {
  const senders = createTelegramSenders({
    TELEGRAM_OWNER_BOT_TOKEN: "owner-token",
  });
  const secrets = parseTelegramWebhookSecrets({
    TELEGRAM_TEACHER_WEBHOOK_SECRET: "teacher-secret",
  });

  assert.deepEqual(Object.keys(senders), ["owner"]);
  assert.deepEqual(secrets, { teacher: "teacher-secret" });
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
    "https://agent.timeweb.cloud/api/v1/cloud-ai/agents/agent-owner/v1/chat/completions",
  );
});

test("production dependencies build repositories from Prisma client", async () => {
  const dependencies = createProductionDependencies({
    env: {
      TIMEWEB_AI_API_KEY: "timeweb-key",
      TELEGRAM_BOT_TOKEN: "telegram-token",
    },
    prisma: {
      user: {
        async findUnique({ where }) {
          if (where.telegramUserId === "100") {
            return { id: "owner-1", role: "owner", telegramUserId: "100" };
          }

          return null;
        },
      },
    },
  });

  assert.equal(
    (await dependencies.repositories.users.findByTelegramUserId("100")).id,
    "owner-1",
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
      TELEGRAM_REPLY_MODE: "send_message",
      TELEGRAM_UPDATE_QUEUE_ENABLED: "false",
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
    "https://agent.timeweb.cloud/api/v1/cloud-ai/agents/agent-owner/v1/chat/completions",
  );
  assert.equal(
    calls[1][0],
    "https://api.telegram.org/bottelegram-token/sendMessage",
  );
});

test("async server env factory creates Prisma repositories when DATABASE_URL is set", async () => {
  const calls = [];
  class FakePrismaClient {
    constructor() {
      const messages = [];
      const conversations = [];
      this.user = {
        async findUnique({ where }) {
          if (where.telegramUserId === "100") {
            return {
              id: "owner-1",
              role: "owner",
              telegramUserId: "100",
              workspaceId: "workspace-family",
            };
          }

          return null;
        },
      };
      this.memoryItem = {
        async findMany() {
          return [];
        },
      };
      this.conversation = {
        async upsert({ where, update, create }) {
          const existing = conversations.find(
            (conversation) => conversation.id === where.id,
          );

          if (existing) {
            Object.assign(existing, update);
            return existing;
          }

          conversations.push(create);
          return create;
        },
      };
      this.message = {
        async create({ data }) {
          if (
            !conversations.some(
              (conversation) => conversation.id === data.conversationId,
            )
          ) {
            throw new Error("conversation must exist before message create");
          }

          messages.push(data);
          return data;
        },
        async findMany() {
          return messages;
        },
      };
    }
  }

  const server = await createAppServerFromEnvAsync({
    env: {
      DATABASE_URL: "postgresql://family:test@localhost:5432/family_ai",
      TIMEWEB_AI_API_KEY: "timeweb-key",
      TIMEWEB_AGENT_OWNER_ASSISTANT: "agent-owner",
      TELEGRAM_BOT_TOKEN: "telegram-token",
      TELEGRAM_REPLY_MODE: "send_message",
      TELEGRAM_UPDATE_QUEUE_ENABLED: "false",
    },
    importPrismaClient: async () => ({ PrismaClient: FakePrismaClient }),
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({ text: "Postgres-backed answer" });
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/telegram/webhook`, {
      update_id: 901,
      message: {
        chat: { id: 777 },
        from: { id: 100 },
        text: "hello",
      },
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).text, "Postgres-backed answer");
  });

  assert.equal(
    calls[0][0],
    "https://agent.timeweb.cloud/api/v1/cloud-ai/agents/agent-owner/v1/chat/completions",
  );
});
