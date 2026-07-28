import assert from "node:assert/strict";
import test from "node:test";

import { ProfileRoutingAiProvider } from "../src/index.js";

function createProvider(name, calls, resultOrError) {
  return {
    async complete(request) {
      calls.push({ name, request });
      if (resultOrError instanceof Error) {
        throw resultOrError;
      }

      return resultOrError;
    },
  };
}

test("ProfileRoutingAiProvider.complete routes by model profile", async () => {
  const calls = [];
  const provider = new ProfileRoutingAiProvider({
    providers: {
      kimi: createProvider("kimi", calls, { text: "kimi ok" }),
      timeweb: createProvider("timeweb", calls, { text: "timeweb ok" }),
    },
    routes: {
      cheap: ["kimi", "timeweb"],
      strong: ["timeweb"],
    },
  });

  const cheap = await provider.complete({
    modelProfile: { profile: "cheap" },
    messages: [],
  });
  const strong = await provider.complete({
    modelProfile: { profile: "strong" },
    messages: [],
  });

  assert.deepEqual(cheap, { text: "kimi ok" });
  assert.deepEqual(strong, { text: "timeweb ok" });
  assert.deepEqual(
    calls.map((call) => call.name),
    ["kimi", "timeweb"],
  );
});

test("ProfileRoutingAiProvider.complete falls back on retryable provider errors", async () => {
  const calls = [];
  const retryableError = new Error("rate limited");
  retryableError.status = 429;
  const provider = new ProfileRoutingAiProvider({
    providers: {
      kimi: createProvider("kimi", calls, retryableError),
      timeweb: createProvider("timeweb", calls, { text: "timeweb fallback" }),
    },
    routes: {
      standard: ["kimi", "timeweb"],
    },
  });

  const result = await provider.complete({
    modelProfile: { profile: "standard" },
    messages: [],
  });

  assert.deepEqual(result, { text: "timeweb fallback" });
  assert.deepEqual(
    calls.map((call) => call.name),
    ["kimi", "timeweb"],
  );
});

test("ProfileRoutingAiProvider.complete does not hide configuration errors", async () => {
  const calls = [];
  const authError = new Error("unauthorized");
  authError.status = 401;
  const provider = new ProfileRoutingAiProvider({
    providers: {
      kimi: createProvider("kimi", calls, authError),
      timeweb: createProvider("timeweb", calls, { text: "should not run" }),
    },
    routes: {
      standard: ["kimi", "timeweb"],
    },
  });

  await assert.rejects(
    () =>
      provider.complete({
        modelProfile: { profile: "standard" },
        messages: [],
      }),
    /unauthorized/,
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ["kimi"],
  );
});
