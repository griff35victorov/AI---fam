import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramWebhookUrl,
  runTelegramWebhookCli,
  setTelegramWebhook,
} from "../telegram-webhook.js";

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

test("buildTelegramWebhookUrl uses the public app URL", () => {
  assert.equal(
    buildTelegramWebhookUrl({
      APP_PUBLIC_URL: "https://family.example.ru/",
    }),
    "https://family.example.ru/telegram/webhook",
  );
});

test("buildTelegramWebhookUrl uses a dedicated bot path", () => {
  assert.equal(
    buildTelegramWebhookUrl(
      {
        APP_PUBLIC_URL: "https://family.example.ru/",
      },
      { botKey: "teacher" },
    ),
    "https://family.example.ru/telegram/teacher/webhook",
  );
});

test("setTelegramWebhook validates bot and registers secret webhook", async () => {
  const calls = [];
  const result = await setTelegramWebhook({
    env: {
      TELEGRAM_BOT_TOKEN: "bot-token",
      APP_PUBLIC_URL: "https://family.example.ru",
      TELEGRAM_WEBHOOK_SECRET: "secret-token",
      TELEGRAM_DROP_PENDING_UPDATES: "true",
      TELEGRAM_API_BASE_URL: "https://telegram.example",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true, result: true });
    },
  });

  assert.deepEqual(result, { ok: true, result: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://telegram.example/botbot-token/getMe");
  assert.equal(calls[1].url, "https://telegram.example/botbot-token/setWebhook");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    url: "https://family.example.ru/telegram/webhook",
    allowed_updates: ["message"],
    max_connections: 1,
    secret_token: "secret-token",
    drop_pending_updates: true,
  });
});

test("setTelegramWebhook can register a dedicated daughter bot webhook", async () => {
  const calls = [];
  await setTelegramWebhook({
    botKey: "daughter",
    env: {
      TELEGRAM_DAUGHTER_BOT_TOKEN: "daughter-token",
      APP_PUBLIC_URL: "https://family.example.ru",
      TELEGRAM_DAUGHTER_WEBHOOK_SECRET: "daughter-secret",
      TELEGRAM_API_BASE_URL: "https://telegram.example",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true, result: true });
    },
  });

  assert.equal(calls[0].url, "https://telegram.example/botdaughter-token/getMe");
  assert.equal(calls[1].url, "https://telegram.example/botdaughter-token/setWebhook");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    url: "https://family.example.ru/telegram/daughter/webhook",
    allowed_updates: ["message"],
    max_connections: 1,
    secret_token: "daughter-secret",
  });
});

test("runTelegramWebhookCli can register all dedicated bot webhooks", async () => {
  const calls = [];

  const exitCode = await runTelegramWebhookCli({
    argv: ["set", "all"],
    env: {
      TELEGRAM_OWNER_BOT_TOKEN: "owner-token",
      TELEGRAM_DAUGHTER_BOT_TOKEN: "daughter-token",
      TELEGRAM_TEACHER_BOT_TOKEN: "teacher-token",
      APP_PUBLIC_URL: "https://family.example.ru",
      TELEGRAM_API_BASE_URL: "https://telegram.example",
    },
    stdout: { write() {} },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true, result: true });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 6);
  assert.equal(calls[1].url, "https://telegram.example/botowner-token/setWebhook");
  assert.equal(calls[3].url, "https://telegram.example/botdaughter-token/setWebhook");
  assert.equal(calls[5].url, "https://telegram.example/botteacher-token/setWebhook");
  assert.deepEqual(JSON.parse(calls[5].options.body), {
    url: "https://family.example.ru/telegram/teacher/webhook",
    allowed_updates: ["message"],
    max_connections: 1,
  });
});

test("runTelegramWebhookCli does not print token or secret", async () => {
  let stdout = "";

  const exitCode = await runTelegramWebhookCli({
    argv: ["set"],
    env: {
      TELEGRAM_BOT_TOKEN: "bot-token",
      APP_PUBLIC_URL: "https://family.example.ru",
      TELEGRAM_WEBHOOK_SECRET: "secret-token",
    },
    stdout: {
      write(chunk) {
        stdout += chunk;
      },
    },
    fetchImpl: async () => jsonResponse({ ok: true, result: true }),
  });

  assert.equal(exitCode, 0);
  assert.doesNotMatch(stdout, /bot-token/);
  assert.doesNotMatch(stdout, /secret-token/);
});

test("runTelegramWebhookCli rejects unknown actions", async () => {
  let stderr = "";

  const exitCode = await runTelegramWebhookCli({
    argv: ["unknown"],
    env: {},
    stderr: {
      write(chunk) {
        stderr += chunk;
      },
    },
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  assert.equal(exitCode, 1);
  assert.match(stderr, /set\|delete\|info/);
});
