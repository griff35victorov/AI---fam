import assert from "node:assert/strict";
import test from "node:test";

import { createRelayNodeServer } from "../src/node-server.js";

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

test("Node relay server exposes health endpoint", async () => {
  const server = createRelayNodeServer({
    env: {},
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "telegram-relay",
    });
  });
});

test("Node relay server forwards webhook requests", async () => {
  const calls = [];
  const server = createRelayNodeServer({
    env: {
      TIMEWEB_APP_URL: "https://timeweb.example",
      TELEGRAM_OWNER_WEBHOOK_SECRET: "owner-secret",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ method: "sendMessage", chat_id: 777, text: "ok" });
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/telegram/owner/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "owner-secret",
      },
      body: JSON.stringify({
        update_id: 20,
        message: {
          chat: { id: 777 },
          from: { id: 111 },
          text: "hello",
        },
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      method: "sendMessage",
      chat_id: 777,
      text: "ok",
    });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://timeweb.example/telegram/owner/webhook");
});
