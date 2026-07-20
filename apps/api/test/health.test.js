import assert from "node:assert/strict";
import test from "node:test";

import { createHealthResponse } from "../src/health.js";

test("health response reports ok and core subsystem names", () => {
  const response = createHealthResponse();

  assert.equal(response.status, "ok");
  assert.deepEqual(response.subsystems, ["api", "database", "ai_provider", "worker"]);
});
