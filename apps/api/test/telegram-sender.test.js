import assert from "node:assert/strict";
import test from "node:test";

import {
  TelegramBotSender,
  TelegramFailoverSender,
  TelegramRelaySender,
} from "../src/telegram-sender.js";

test("TelegramBotSender sends a Telegram message through Bot API", async () => {
  const calls = [];
  const sender = new TelegramBotSender({
    botToken: "token-123",
    baseUrl: "https://telegram.example",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { ok: true, result: { message_id: 42 } };
        },
      };
    },
  });

  const result = await sender.sendMessage({ chatId: 777, text: "hello" });

  assert.deepEqual(result, { ok: true, result: { message_id: 42 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://telegram.example/bottoken-123/sendMessage");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].options.headers, { "content-type": "application/json" });
  assert.equal(calls[0].options.body, JSON.stringify({ chat_id: 777, text: "hello" }));
});

test("TelegramBotSender disables Telegram link previews by default", async () => {
  const calls = [];
  const sender = new TelegramBotSender({
    botToken: "token-123",
    baseUrl: "https://telegram.example",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { ok: true, result: { message_id: 42 } };
        },
      };
    },
  });

  await sender.sendMessage({ chatId: 777, text: "https://example.com" });

  assert.deepEqual(JSON.parse(calls[0].options.body).link_preview_options, {
    is_disabled: true,
  });
});

test("TelegramBotSender splits long Telegram messages into chunks", async () => {
  const calls = [];
  const sender = new TelegramBotSender({
    botToken: "token-123",
    baseUrl: "https://telegram.example",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { ok: true, result: { message_id: calls.length } };
        },
      };
    },
  });

  const result = await sender.sendMessage({ chatId: 777, text: "a".repeat(4200) });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(JSON.parse(calls[0].options.body).text.length <= 3900);
  assert.ok(JSON.parse(calls[1].options.body).text.length <= 3900);
});

test("TelegramBotSender sends typing chat action", async () => {
  const calls = [];
  const sender = new TelegramBotSender({
    botToken: "token-123",
    baseUrl: "https://telegram.example",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { ok: true };
        },
      };
    },
  });

  await sender.sendChatAction({ chatId: 777, action: "typing" });

  assert.equal(calls[0].url, "https://telegram.example/bottoken-123/sendChatAction");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chat_id: 777,
    action: "typing",
  });
});

test("TelegramBotSender aborts slow sends by timeout", async () => {
  const sender = new TelegramBotSender({
    botToken: "token-123",
    timeoutMs: 1,
    maxAttempts: 1,
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      }),
  });

  await assert.rejects(
    () => sender.sendMessage({ chatId: 777, text: "hello" }),
    /Telegram sendMessage network failed: aborted/,
  );
});

test("TelegramBotSender retries transient network failures", async () => {
  let calls = 0;
  const sender = new TelegramBotSender({
    botToken: "token-123",
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        throw new TypeError("fetch failed");
      }

      return {
        ok: true,
        async json() {
          return { ok: true, result: { message_id: 43 } };
        },
      };
    },
  });

  const result = await sender.sendMessage({ chatId: 777, text: "hello" });

  assert.equal(calls, 3);
  assert.deepEqual(result, { ok: true, result: { message_id: 43 } });
});

test("TelegramBotSender retries retryable Bot API response statuses", async () => {
  let calls = 0;
  const sender = new TelegramBotSender({
    botToken: "token-123",
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        return {
          ok: false,
          status: 500,
          async json() {
            return { ok: false };
          },
        };
      }

      return {
        ok: true,
        async json() {
          return { ok: true, result: { message_id: 44 } };
        },
      };
    },
  });

  const result = await sender.sendMessage({ chatId: 777, text: "hello" });

  assert.equal(calls, 3);
  assert.deepEqual(result, { ok: true, result: { message_id: 44 } });
});

test("TelegramBotSender requires bot token before sending", async () => {
  const sender = new TelegramBotSender({
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  await assert.rejects(
    () => sender.sendMessage({ chatId: 777, text: "hello" }),
    /TELEGRAM_BOT_TOKEN is required/,
  );
});

test("TelegramBotSender labels exhausted network failures", async () => {
  const sender = new TelegramBotSender({
    botToken: "token-123",
    retryDelayMs: 0,
    maxAttempts: 2,
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });

  await assert.rejects(
    () => sender.sendMessage({ chatId: 777, text: "hello" }),
    /Telegram sendMessage network failed: fetch failed/,
  );
});

test("TelegramBotSender reports failed Bot API response status", async () => {
  const sender = new TelegramBotSender({
    botToken: "token-123",
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      async json() {
        return { ok: false };
      },
    }),
  });

  await assert.rejects(
    () => sender.sendMessage({ chatId: 777, text: "hello" }),
    /Telegram sendMessage failed with 429/,
  );
});

test("TelegramRelaySender sends a message through protected relay endpoint", async () => {
  const calls = [];
  const sender = new TelegramRelaySender({
    relayUrl: "https://relay.example/",
    relaySecret: "relay-secret",
    botKey: "owner",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: 45 } };
        },
      };
    },
  });

  const result = await sender.sendMessage({ chatId: 777, text: "hello relay" });

  assert.deepEqual(result, { ok: true, result: { message_id: 45 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://relay.example/telegram/owner/send");
  assert.deepEqual(calls[0].options.headers, {
    "content-type": "application/json",
    "x-family-ai-relay-secret": "relay-secret",
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chat_id: 777,
    text: "hello relay",
  });
});

test("TelegramRelaySender requires relay configuration", async () => {
  const sender = new TelegramRelaySender({
    relayUrl: "https://relay.example",
    botKey: "owner",
  });

  await assert.rejects(
    () => sender.sendMessage({ chatId: 777, text: "hello" }),
    /TELEGRAM_RELAY_SECRET is required/,
  );
});

test("TelegramFailoverSender uses fallback sender after primary failure", async () => {
  const fallbackMessages = [];
  const sender = new TelegramFailoverSender({
    primary: {
      async sendMessage() {
        throw new Error("primary failed");
      },
    },
    fallback: {
      async sendMessage(message) {
        fallbackMessages.push(message);
        return { ok: true, result: { message_id: 50 } };
      },
    },
  });

  const result = await sender.sendMessage({ chatId: 777, text: "hello" });

  assert.deepEqual(result, { ok: true, result: { message_id: 50 } });
  assert.deepEqual(fallbackMessages, [{ chatId: 777, text: "hello" }]);
});

test("TelegramFailoverSender does not resend whole message after partial delivery", async () => {
  const fallbackMessages = [];
  const primary = new TelegramBotSender({
    botToken: "token-123",
    baseUrl: "https://telegram.example",
    maxAttempts: 1,
    fetchImpl: async (_url, options) => {
      const text = JSON.parse(options.body).text;
      if (text.startsWith("a")) {
        return {
          ok: true,
          async json() {
            return { ok: true, result: { message_id: 51 } };
          },
        };
      }

      throw new Error("second chunk failed");
    },
  });
  const sender = new TelegramFailoverSender({
    primary,
    fallback: {
      async sendMessage(message) {
        fallbackMessages.push(message);
        return { ok: true, result: { message_id: 52 } };
      },
    },
  });

  let error;
  try {
    await sender.sendMessage({ chatId: 777, text: `${"a".repeat(3900)} b` });
  } catch (caught) {
    error = caught;
  }

  assert.equal(error?.partialDelivery, true);
  assert.deepEqual(fallbackMessages, []);
});

test("TelegramFailoverSender does not fallback after relay reports partial delivery", async () => {
  const fallbackMessages = [];
  const primary = new TelegramRelaySender({
    relayUrl: "https://relay.example",
    relaySecret: "relay-secret",
    botKey: "owner",
    fetchImpl: async () =>
      Response.json({ error: "telegram_partial_delivery_failed" }, { status: 409 }),
  });
  const sender = new TelegramFailoverSender({
    primary,
    fallback: {
      async sendMessage(message) {
        fallbackMessages.push(message);
        return { ok: true, result: { message_id: 53 } };
      },
    },
  });

  let error;
  try {
    await sender.sendMessage({ chatId: 777, text: "long answer" });
  } catch (caught) {
    error = caught;
  }

  assert.equal(error?.partialDelivery, true);
  assert.deepEqual(fallbackMessages, []);
});
