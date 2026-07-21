import assert from "node:assert/strict";
import test from "node:test";

import { handleRelayRequest } from "../src/worker.js";

function request(path, { secret = "owner-secret", body } = {}) {
  return new Request(`https://relay.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(
      body ?? {
        update_id: 10,
        message: {
          chat: { id: 777 },
          from: { id: 111 },
          text: "hello",
        },
      },
    ),
  });
}

function env(overrides = {}) {
  return {
    TIMEWEB_APP_URL: "https://timeweb.example/",
    TELEGRAM_OWNER_WEBHOOK_SECRET: "owner-secret",
    TELEGRAM_DAUGHTER_WEBHOOK_SECRET: "daughter-secret",
    TELEGRAM_TEACHER_WEBHOOK_SECRET: "teacher-secret",
    RELAY_ACK_TEXT: "Запрос получен.",
    TIMEWEB_FORWARD_RETRY_DELAY_MS: "0",
    ...overrides,
  };
}

async function json(response) {
  return response.json();
}

test("GET /health returns relay status", async () => {
  const response = await handleRelayRequest(
    new Request("https://relay.example/health"),
    env(),
    {},
    {
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), {
    ok: true,
    service: "telegram-relay",
  });
});

test("rejects requests with an invalid Telegram secret without forwarding", async () => {
  let forwarded = false;
  const response = await handleRelayRequest(
    request("/telegram/owner/webhook", { secret: "wrong-secret" }),
    env(),
    {},
    {
      fetchImpl: async () => {
        forwarded = true;
        throw new Error("fetch should not be called");
      },
    },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await json(response), { error: "telegram_webhook_secret_invalid" });
  assert.equal(forwarded, false);
});

test("dedicated webhook routes require their dedicated secret", async () => {
  const response = await handleRelayRequest(
    request("/telegram/owner/webhook", { secret: "legacy-secret" }),
    env({
      TELEGRAM_OWNER_WEBHOOK_SECRET: "",
      TELEGRAM_WEBHOOK_SECRET: "legacy-secret",
    }),
    {},
    {
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      },
    },
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await json(response), {
    error: "telegram_webhook_secret_not_configured",
  });
});

test("returns a fast Timeweb webhook response when Timeweb answers", async () => {
  const calls = [];
  const timewebBody = {
    method: "sendMessage",
    chat_id: 777,
    text: "Принял. Готовлю ответ отдельным сообщением.",
  };

  const response = await handleRelayRequest(
    request("/telegram/owner/webhook"),
    env(),
    {},
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return Response.json(timewebBody);
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), timewebBody);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://timeweb.example/telegram/owner/webhook");
  assert.equal(calls[0].options.headers["x-telegram-bot-api-secret-token"], "owner-secret");
  assert.equal(calls[0].options.body.includes('"update_id":10'), true);
});

test("falls back immediately and retries in background when Timeweb fails", async () => {
  const calls = [];
  const waited = [];
  const response = await handleRelayRequest(
    request("/telegram/daughter/webhook", { secret: "daughter-secret" }),
    env({ TIMEWEB_FORWARD_RETRIES: "1" }),
    {
      waitUntil(promise) {
        waited.push(promise);
      },
    },
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1) {
          throw new Error("temporary network error");
        }

        return Response.json({ ok: true });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), {
    method: "sendMessage",
    chat_id: 777,
    text: "Запрос получен.",
  });
  assert.equal(waited.length, 1);
  await waited[0];
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://timeweb.example/telegram/daughter/webhook");
  assert.equal(calls[1].options.headers["x-telegram-bot-api-secret-token"], "daughter-secret");
});

test("uses ok fallback when an update has no chat id", async () => {
  const response = await handleRelayRequest(
    request("/telegram/teacher/webhook", {
      secret: "teacher-secret",
      body: { update_id: 11 },
    }),
    env(),
    {},
    {
      fetchImpl: async () => {
        throw new Error("network down");
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true });
});

test("protected send endpoint sends through Telegram Bot API", async () => {
  const calls = [];
  const response = await handleRelayRequest(
    new Request("https://relay.example/telegram/owner/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-family-ai-relay-secret": "relay-secret",
      },
      body: JSON.stringify({ chat_id: 777, text: "Final answer" }),
    }),
    env({
      TELEGRAM_RELAY_SECRET: "relay-secret",
      TELEGRAM_OWNER_BOT_TOKEN: "owner-token",
      TELEGRAM_API_BASE_URL: "https://telegram.example",
    }),
    {},
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return Response.json({ ok: true, result: { message_id: 42 } });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true, result: { message_id: 42 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://telegram.example/botowner-token/sendMessage");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chat_id: 777,
    text: "Final answer",
  });
});

test("protected send endpoint rejects invalid relay secret without sending", async () => {
  let sent = false;
  const response = await handleRelayRequest(
    new Request("https://relay.example/telegram/teacher/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-family-ai-relay-secret": "wrong-secret",
      },
      body: JSON.stringify({ chat_id: 777, text: "Final answer" }),
    }),
    env({
      TELEGRAM_RELAY_SECRET: "relay-secret",
      TELEGRAM_TEACHER_BOT_TOKEN: "teacher-token",
    }),
    {},
    {
      fetchImpl: async () => {
        sent = true;
        throw new Error("fetch should not be called");
      },
    },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await json(response), { error: "relay_secret_invalid" });
  assert.equal(sent, false);
});
