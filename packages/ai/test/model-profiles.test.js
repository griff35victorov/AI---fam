import assert from "node:assert/strict";
import test from "node:test";

import { resolveModelProfile, estimateTokenCostRub } from "../src/index.js";

test("model profile resolves routine requests to cheap profile", () => {
  assert.equal(resolveModelProfile("routing").profile, "cheap");
  assert.equal(resolveModelProfile("reminder_summary").profile, "cheap");
});

test("model profile resolves teacher and study work to standard profile", () => {
  assert.equal(resolveModelProfile("lesson_preparation").profile, "standard");
  assert.equal(resolveModelProfile("ege_explanation").profile, "standard");
});

test("model profile resolves design and technical analysis to strong profile", () => {
  assert.equal(resolveModelProfile("gazebo_design").profile, "strong");
  assert.equal(resolveModelProfile("technical_analysis").profile, "strong");
});

test("cost estimate uses input and output token prices per million", () => {
  const cost = estimateTokenCostRub({
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    inputRubPerMillion: 100,
    outputRubPerMillion: 200,
  });

  assert.equal(cost, 200);
});
