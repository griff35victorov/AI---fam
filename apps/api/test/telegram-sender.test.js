import assert from "node:assert/strict";
import test from "node:test";

import { TelegramBotSender } from "../src/telegram-sender.js";

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
