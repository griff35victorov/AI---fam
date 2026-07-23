import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryRepositories } from "@family-ai/db";
import { pollTelegramBotOnce } from "../src/telegram-poller.js";
import { startTelegramPolling } from "../src/telegram-poller.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

test("startTelegramPolling reads and persists bot offset through repository state", async () => {
  const repositories = createInMemoryRepositories({
    telegramPollingStates: [
      {
        botKey: "owner",
        offset: 41,
        createdAt: new Date("2026-07-23T08:00:00.000Z"),
        updatedAt: new Date("2026-07-23T08:00:00.000Z"),
      },
    ],
  });
  const handled = [];
  const urls = [];
  let firstFetch = true;

  const polling = startTelegramPolling({
    botTokens: { owner: "owner-token" },
    pollingStateRepository: repositories.telegramPollingStates,
    workerId: "poller-1",
    intervalMs: 10,
    timeoutSeconds: 1,
    baseUrl: "https://telegram.example",
    fetchImpl: async (url) => {
      urls.push(url);
      const result = firstFetch
        ? [{ update_id: 41, message: { text: "stored offset" } }]
        : [];
      firstFetch = false;
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result };
        },
      };
    },
    handleUpdate: async (botKey, update) => {
      handled.push({ botKey, updateId: update.update_id });
    },
  });

  for (let attempt = 0; attempt < 20 && handled.length === 0; attempt += 1) {
    await delay(10);
  }
  polling.stop();
  await polling.done;

  assert.deepEqual(handled, [{ botKey: "owner", updateId: 41 }]);
  assert.match(urls[0], /offset=41/);
  const state = await repositories.telegramPollingStates.get("owner");
  assert.equal(state.offset, 42);
  assert.equal(state.lastUpdateId, 41);
});

test("startTelegramPolling clears Telegram webhook before polling", async () => {
  const calls = [];
  let handled = false;

  const polling = startTelegramPolling({
    botTokens: { owner: "owner-token" },
    clearWebhookBeforePolling: true,
    intervalMs: 10,
    timeoutSeconds: 1,
    baseUrl: "https://telegram.example",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? "GET", body: options.body });
      const isDeleteWebhook = String(url).includes("/deleteWebhook");
      return {
        ok: true,
        status: 200,
        async json() {
          return isDeleteWebhook
            ? { ok: true, result: true }
            : { ok: true, result: [{ update_id: 100, message: { text: "after clear" } }] };
        },
      };
    },
    handleUpdate: async () => {
      handled = true;
    },
  });

  for (let attempt = 0; attempt < 20 && !handled; attempt += 1) {
    await delay(10);
  }
  polling.stop();
  await polling.done;

  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/deleteWebhook$/);
  assert.deepEqual(JSON.parse(calls[0].body), { drop_pending_updates: false });
  assert.match(calls[1].url, /\/getUpdates\?/);
});

test("startTelegramPolling clears webhook again after Telegram conflict", async () => {
  const calls = [];
  let handled = false;
  let getUpdatesCount = 0;

  const polling = startTelegramPolling({
    botTokens: { owner: "owner-token" },
    clearWebhookBeforePolling: true,
    intervalMs: 10,
    errorDelayMs: 10,
    timeoutSeconds: 1,
    baseUrl: "https://telegram.example",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method ?? "GET" });
      const isDeleteWebhook = String(url).includes("/deleteWebhook");
      if (isDeleteWebhook) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, result: true };
          },
        };
      }

      getUpdatesCount += 1;
      return {
        ok: getUpdatesCount > 1,
        status: getUpdatesCount > 1 ? 200 : 409,
        async json() {
          return getUpdatesCount > 1
            ? { ok: true, result: [{ update_id: 101, message: { text: "after conflict" } }] }
            : { ok: false, description: "Conflict: can't use getUpdates method while webhook is active" };
        },
      };
    },
    handleUpdate: async () => {
      handled = true;
    },
    logger: { error() {} },
  });

  for (let attempt = 0; attempt < 30 && !handled; attempt += 1) {
    await delay(10);
  }
  polling.stop();
  await polling.done;

  const deleteWebhookCalls = calls.filter((call) => call.url.includes("/deleteWebhook"));
  assert.equal(deleteWebhookCalls.length, 2);
  assert.equal(handled, true);
});

test("startTelegramPolling does not poll when another process owns the bot lease", async () => {
  const repositories = createInMemoryRepositories({
    telegramPollingStates: [
      {
        botKey: "owner",
        lockedBy: "other-poller",
        lockedUntil: new Date(Date.now() + 60_000),
      },
    ],
  });
  let fetchCount = 0;

  const polling = startTelegramPolling({
    botTokens: { owner: "owner-token" },
    pollingStateRepository: repositories.telegramPollingStates,
    workerId: "poller-1",
    intervalMs: 10,
    timeoutSeconds: 1,
    fetchImpl: async () => {
      fetchCount += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: [] };
        },
      };
    },
    handleUpdate: async () => {},
  });

  await delay(35);
  polling.stop();
  await polling.done;

  assert.equal(fetchCount, 0);
});
