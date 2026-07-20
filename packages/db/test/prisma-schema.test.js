import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Prisma Job model contains worker runtime fields", async () => {
  const schema = await readFile(
    new URL("../prisma/schema.prisma", import.meta.url),
    "utf8",
  );

  for (const field of [
    ["lockedBy", "String?"],
    ["result", "Json?"],
    ["error", "String?"],
    ["completedAt", "DateTime?"],
    ["failedAt", "DateTime?"],
  ]) {
    const [name, type] = field;
    assert.match(schema, new RegExp(`${name}\\s+${type.replace("?", "\\?")}`));
  }
});

test("initial migration contains worker runtime Job columns", async () => {
  const migration = await readFile(
    new URL("../prisma/migrations/20260720000000_init/migration.sql", import.meta.url),
    "utf8",
  );

  for (const column of [
    '"lockedBy" TEXT',
    '"result" JSONB',
    '"error" TEXT',
    '"completedAt" TIMESTAMP(3)',
    '"failedAt" TIMESTAMP(3)',
  ]) {
    assert.match(migration, new RegExp(column.replace(/[()]/g, "\\$&")));
  }
});

test("initial migration seeds default family workspace", async () => {
  const migration = await readFile(
    new URL("../prisma/migrations/20260720000000_init/migration.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /INSERT INTO "Workspace"/);
  assert.match(migration, /workspace-family/);
});
