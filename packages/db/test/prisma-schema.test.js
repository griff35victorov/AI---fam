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

test("material chunk migration adds searchable library storage", async () => {
  const schema = await readFile(
    new URL("../prisma/schema.prisma", import.meta.url),
    "utf8",
  );
  const migration = await readFile(
    new URL("../prisma/migrations/20260721000000_material_chunks/migration.sql", import.meta.url),
    "utf8",
  );

  assert.match(schema, /model MaterialChunk/);
  assert.match(schema, /chunks\s+MaterialChunk\[\]/);
  assert.match(migration, /CREATE TABLE "MaterialChunk"/);
  assert.match(migration, /MaterialChunk_workspaceId_ownerUserId_idx/);
});

test("Telegram polling state migration persists bot offsets and leases", async () => {
  const schema = await readFile(
    new URL("../prisma/schema.prisma", import.meta.url),
    "utf8",
  );
  const migration = await readFile(
    new URL("../prisma/migrations/20260723000000_telegram_polling_state/migration.sql", import.meta.url),
    "utf8",
  );

  assert.match(schema, /model TelegramPollingState/);
  assert.match(schema, /botKey\s+String\s+@id/);
  assert.match(schema, /offset\s+Int\?/);
  assert.match(schema, /lastHeartbeatAt\s+DateTime\?/);
  assert.match(migration, /CREATE TABLE "TelegramPollingState"/);
  assert.match(migration, /"botKey" TEXT NOT NULL/);
  assert.match(migration, /"offset" INTEGER/);
});
