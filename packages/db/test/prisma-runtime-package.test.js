import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("root package pins Prisma runtime and CLI packages", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  );

  assert.equal(packageJson.dependencies?.["@prisma/client"], "6.19.2");
  assert.equal(packageJson.dependencies?.prisma, "6.19.2");
});

test("package lock pins the Prisma install graph for Docker builds", async () => {
  const lockfile = JSON.parse(
    await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8"),
  );

  assert.equal(lockfile.lockfileVersion, 3);
  assert.equal(lockfile.packages?.[""]?.dependencies?.["@prisma/client"], "6.19.2");
  assert.equal(lockfile.packages?.[""]?.dependencies?.prisma, "6.19.2");
  assert.equal(lockfile.packages?.["node_modules/@prisma/client"]?.version, "6.19.2");
  assert.equal(lockfile.packages?.["node_modules/prisma"]?.version, "6.19.2");
});

test("db package exposes the same Prisma workflow script names", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.equal(packageJson.scripts?.["db:generate"], "prisma generate --schema prisma/schema.prisma");
  assert.equal(packageJson.scripts?.["db:migrate"], "prisma migrate deploy --schema prisma/schema.prisma");
  assert.equal(packageJson.scripts?.["db:migrate:dev"], "prisma migrate dev --schema prisma/schema.prisma");
  assert.equal(packageJson.scripts?.["db:smoke"], "node src/smoke.js");
});

test("db package does not expose ambiguous unprefixed database scripts", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  for (const scriptName of ["generate", "migrate", "migrate:dev", "smoke"]) {
    assert.equal(packageJson.scripts?.[scriptName], undefined);
  }
});

test("Docker build installs locked dependencies and generates Prisma Client before production runtime", async () => {
  const dockerfile = await readFile(
    new URL("../../../Dockerfile", import.meta.url),
    "utf8",
  );

  assert.match(
    dockerfile,
    /COPY package-lock\.json \.\/[\s\S]*RUN npm ci --omit=dev --ignore-scripts[\s\S]*RUN npm run db:generate[\s\S]*ENV NODE_ENV=production[\s\S]*HEALTHCHECK/,
  );
});
