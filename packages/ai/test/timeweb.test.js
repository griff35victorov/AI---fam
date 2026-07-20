import assert from "node:assert/strict";
import test from "node:test";

import { TimewebAiProvider } from "../src/index.js";

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

test("TimewebAiProvider.complete uses agentProfile and modelProfile for Timeweb call", async () => {
  const messages = [{ role: "user", content: "Hello" }];
  const calls = [];
  const provider = new TimewebAiProvider({
    baseUrl: "https://timeweb.example",
    apiKey: "test-key",
    agentIds: {
      tutor: "agent-123",
    },
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({ answer: { text: "Hi there" } });
    },
  });

  const result = await provider.complete({
    agentProfile: "tutor",
    modelProfile: { model: "tw-model" },
    messages,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://timeweb.example/api/v1/cloud-ai/agents/agent-123/call");
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].headers.authorization, "Bearer test-key");
  assert.equal(calls[0][1].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    messages,
    model: "tw-model",
  });
  assert.deepEqual(result, {
    text: "Hi there",
    raw: { answer: { text: "Hi there" } },
  });
});

test("TimewebAiProvider.complete normalizes top-level text responses", async () => {
  const provider = new TimewebAiProvider({
    baseUrl: "https://timeweb.example",
    apiKey: "test-key",
    agentIds: {
      tutor: "agent-123",
    },
    fetchImpl: async () => jsonResponse({ text: "Top-level text" }),
  });

  const result = await provider.complete({
    agentProfile: "tutor",
    modelProfile: { model: "tw-model" },
    messages: [{ role: "user", content: "Hello" }],
  });

  assert.deepEqual(result, {
    text: "Top-level text",
    raw: { text: "Top-level text" },
  });
});

test("TimewebAiProvider.complete keeps legacy agentId and model payload support", async () => {
  const messages = [{ role: "user", content: "Legacy call" }];
  const calls = [];
  const provider = new TimewebAiProvider({
    baseUrl: "https://timeweb.example",
    apiKey: "test-key",
    fetchImpl: async (...args) => {
      calls.push(args);
      return jsonResponse({ answer: { text: "Legacy response" } });
    },
  });

  const result = await provider.complete({
    agentId: "legacy-agent",
    model: "legacy-model",
    messages,
  });

  assert.equal(calls[0][0], "https://timeweb.example/api/v1/cloud-ai/agents/legacy-agent/call");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    messages,
    model: "legacy-model",
  });
  assert.deepEqual(result, { answer: { text: "Legacy response" } });
});

test("TimewebAiProvider.complete explains missing api key", async () => {
  const provider = new TimewebAiProvider({
    baseUrl: "https://timeweb.example",
    apiKey: "",
    agentIds: {
      tutor: "agent-123",
    },
    fetchImpl: async () => jsonResponse({ text: "unused" }),
  });

  await assert.rejects(
    () =>
      provider.complete({
        agentProfile: "tutor",
        modelProfile: { model: "tw-model" },
        messages: [],
      }),
    /TIMEWEB_AI_API_KEY is required/,
  );
});

test("TimewebAiProvider.complete explains missing agent id for profile", async () => {
  const provider = new TimewebAiProvider({
    baseUrl: "https://timeweb.example",
    apiKey: "test-key",
    agentIds: {
      tutor: "agent-123",
    },
    fetchImpl: async () => jsonResponse({ text: "unused" }),
  });

  await assert.rejects(
    () =>
      provider.complete({
        agentProfile: "unknown",
        modelProfile: { model: "tw-model" },
        messages: [],
      }),
    /Timeweb agentId is required for agentProfile "unknown"/,
  );
});
