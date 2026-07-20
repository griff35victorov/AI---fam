import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBudget } from "../src/index.js";

test("budget allows request within daily and monthly limits", () => {
  const result = evaluateBudget({
    dailyLimitRub: 100,
    monthlyLimitRub: 1000,
    currentDailyRub: 20,
    currentMonthlyRub: 200,
    estimatedRub: 15,
  });

  assert.deepEqual(result, {
    allowed: true,
    reason: null,
    remainingDailyRub: 65,
    remainingMonthlyRub: 785,
  });
});

test("budget blocks request over daily limit", () => {
  const result = evaluateBudget({
    dailyLimitRub: 100,
    monthlyLimitRub: 1000,
    currentDailyRub: 95,
    currentMonthlyRub: 200,
    estimatedRub: 10,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "daily_budget_exceeded");
});

test("budget blocks request over monthly limit", () => {
  const result = evaluateBudget({
    dailyLimitRub: 100,
    monthlyLimitRub: 1000,
    currentDailyRub: 20,
    currentMonthlyRub: 995,
    estimatedRub: 10,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "monthly_budget_exceeded");
});
