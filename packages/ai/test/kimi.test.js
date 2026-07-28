import assert from "node:assert/strict";
import test from "node:test";

import { KimiAiProvider } from "../src/index.js";

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("KimiAiProvider.complete sends an OpenAI-compatible chat completion request", async () => {
  const messages = [{ role: "user", content: "Hello" }];
  const calls = [];
  const provider = new KimiAiProvider({
    baseUrl: "https://kimi.example/v1/",
    apiKey: "kimi-key",
    modelByProfile: {
      standard: "kimi-standard",
    },
    maxCompletionTokens: 4096,
    reasoningEffort: "low",
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({
        choices: [{ message: { content: "Kimi answer", role: "assistant" } }],
      });
    },
  });

  const result = await provider.complete({
    modelProfile: { profile: "standard", model: "timeweb-model" },
    messages,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://kimi.example/v1/chat/completions");
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].headers.authorization, "Bearer kimi-key");
  assert.equal(calls[0][1].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    model: "kimi-standard",
    messages,
    stream: false,
    max_completion_tokens: 4096,
    reasoning_effort: "low",
  });
  assert.deepEqual(result, {
    text: "Kimi answer",
    raw: {
      choices: [{ message: { content: "Kimi answer", role: "assistant" } }],
    },
  });
});

test("KimiAiProvider.complete lets an explicit model override the profile model", async () => {
  const calls = [];
  const provider = new KimiAiProvider({
    apiKey: "kimi-key",
    modelByProfile: {
      cheap: "kimi-cheap",
    },
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({ text: "ok" });
    },
  });

  await provider.complete({
    modelProfile: { profile: "cheap" },
    model: "kimi-direct",
    messages: [],
  });

  assert.equal(JSON.parse(calls[0][1].body).model, "kimi-direct");
});

test("KimiAiProvider.complete labels network failures", async () => {
  const provider = new KimiAiProvider({
    apiKey: "kimi-key",
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });

  await assert.rejects(
    () =>
      provider.complete({
        modelProfile: { profile: "standard" },
        messages: [{ role: "user", content: "Hello" }],
      }),
    /Kimi AI request network failed: fetch failed/,
  );
});

test("KimiAiProvider.complete aborts slow requests with a clear timeout", async () => {
  const provider = new KimiAiProvider({
    apiKey: "kimi-key",
    timeoutMs: 1,
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });

  await assert.rejects(
    () =>
      provider.complete({
        modelProfile: { profile: "standard" },
        messages: [{ role: "user", content: "Hello" }],
      }),
    /Kimi AI request timed out after 1ms/,
  );
});

test("KimiAiProvider.complete explains missing api key", async () => {
  const provider = new KimiAiProvider({
    apiKey: "",
    fetchImpl: async () => jsonResponse({ text: "unused" }),
  });

  await assert.rejects(
    () =>
      provider.complete({
        modelProfile: { profile: "standard" },
        messages: [],
      }),
    /KIMI_AI_API_KEY or MOONSHOT_API_KEY is required/,
  );
});

test("KimiAiProvider.complete includes Kimi error details for non-OK responses", async () => {
  const provider = new KimiAiProvider({
    apiKey: "kimi-key",
    fetchImpl: async () =>
      jsonResponse(
        {
          error: {
            message: "invalid api key",
          },
        },
        { ok: false, status: 401 },
      ),
  });

  await assert.rejects(
    () =>
      provider.complete({
        modelProfile: { profile: "standard" },
        messages: [],
      }),
    /Kimi AI request failed with 401: invalid api key/,
  );
});
