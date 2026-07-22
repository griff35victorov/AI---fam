import assert from "node:assert/strict";
import test from "node:test";

import { pollTelegramBotOnce } from "../src/telegram-poller.js";

test("pollTelegramBotOnce fetches Telegram updates and advances offset", async () => {
  const handled = [];
  const urls = [];

  const result = await pollTelegramBotOnce({
    botKey: "owner",
    botToken: "owner-token",
    offset: 41,
    baseUrl: "https://telegram.example",
    fetchImpl: async (url) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            result: [
              { update_id: 41, message: { text: "first" } },
              { update_id: 42, message: { text: "second" } },
            ],
          };
        },
      };
    },
    handleUpdate: async (botKey, update) => {
      handled.push({ botKey, updateId: update.update_id });
    },
  });

  assert.equal(urls.length, 1);
  assert.match(urls[0], /offset=41/);
  assert.match(urls[0], /allowed_updates=%5B%22message%22%5D/);
  assert.deepEqual(handled, [
    { botKey: "owner", updateId: 41 },
    { botKey: "owner", updateId: 42 },
  ]);
  assert.deepEqual(result, { nextOffset: 43, updateCount: 2 });
});

test("pollTelegramBotOnce keeps offset when an update handler fails", async () => {
  const errors = [];

  const result = await pollTelegramBotOnce({
    botKey: "teacher",
    offset: 9,
    botToken: "teacher-token",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          result: [{ update_id: 9, message: { text: "bad" } }],
        };
      },
    }),
    handleUpdate: async () => {
      throw new Error("handler failed");
    },
    logger: {
      error(message, metadata) {
        errors.push({ message, metadata });
      },
    },
  });

  assert.deepEqual(result, { nextOffset: 9, updateCount: 1 });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "telegram polling update failed");
  assert.equal(errors[0].metadata.botKey, "teacher");
});
