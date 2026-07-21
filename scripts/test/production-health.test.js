import assert from "node:assert/strict";
import test from "node:test";

import {
  checkProductionHealth,
  runProductionHealthCli,
} from "../production-health.js";

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

test("checkProductionHealth reads the public health endpoint", async () => {
  const calls = [];
  const summary = await checkProductionHealth({
    env: { APP_PUBLIC_URL: "https://family.example.ru/" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        status: "ok",
        subsystems: ["api", "database"],
      });
    },
  });

  assert.deepEqual(summary, {
    url: "https://family.example.ru/health",
    statusCode: 200,
    status: "ok",
    subsystems: ["api", "database"],
  });
  assert.deepEqual(calls, [
    { url: "https://family.example.ru/health", options: { method: "GET" } },
  ]);
});

test("runProductionHealthCli returns nonzero when health is not ok", async () => {
  let stderr = "";

  const exitCode = await runProductionHealthCli({
    env: { APP_PUBLIC_URL: "https://family.example.ru" },
    stderr: {
      write(chunk) {
        stderr += chunk;
      },
    },
    fetchImpl: async () => jsonResponse({ status: "failed" }),
  });

  assert.equal(exitCode, 1);
  assert.match(stderr, /non-ok/);
});
