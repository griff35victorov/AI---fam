import assert from "node:assert/strict";
import test from "node:test";

import { createPrismaClient } from "../src/index.js";

test("createPrismaClient explains how to install the generated client", async () => {
  const missingClientError = Object.assign(
    new Error("Cannot find package '@prisma/client'"),
    { code: "ERR_MODULE_NOT_FOUND" },
  );

  await assert.rejects(
    () =>
      createPrismaClient({
        importClient: async () => {
          throw missingClientError;
        },
      }),
    (error) => {
      assert.match(error.message, /@prisma\/client is not installed/);
      assert.match(error.message, /db:generate/);
      assert.equal(error.cause, missingClientError);
      return true;
    },
  );
});
