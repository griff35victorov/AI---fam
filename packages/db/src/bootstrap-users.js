import { fileURLToPath } from "node:url";

import { createPrismaClient } from "./client.js";

export const bootstrapUsersEnvName = "FAMILY_AI_BOOTSTRAP_USERS";
export const bootstrapUsersWriteOptInEnvName = "FAMILY_AI_BOOTSTRAP_USERS_ALLOW_WRITE";

const allowedRoles = new Set(["owner", "teacher", "family_child", "system"]);
const defaultTimezone = "Europe/Moscow";
const placeholderTelegramIds = new Set([
  "0",
  "123",
  "123456",
  "123456789",
  "234567890",
  "345678901",
]);
const writeOptInMessage =
  "Bootstrapping users writes to the configured database. Set FAMILY_AI_BOOTSTRAP_USERS_ALLOW_WRITE=1 or pass allowWrites: true to confirm this is intentional.";

function envAllowsWrites(env) {
  return ["1", "true", "yes"].includes(
    String(env?.[bootstrapUsersWriteOptInEnvName] ?? "").toLowerCase(),
  );
}

function normalizeUser(user, index) {
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    throw new Error(`Bootstrap user at index ${index} must be an object`);
  }

  const role = String(user.role ?? "").trim();
  if (!allowedRoles.has(role)) {
    throw new Error(`Bootstrap user at index ${index} has unsupported role`);
  }

  const displayName = String(user.displayName ?? "").trim();
  if (!displayName) {
    throw new Error(`Bootstrap user at index ${index} requires displayName`);
  }

  const id = user.id == null ? undefined : String(user.id).trim();
  const telegramUserId =
    user.telegramUserId == null ? undefined : String(user.telegramUserId).trim();

  if (role !== "system" && !telegramUserId) {
    throw new Error(`Bootstrap user at index ${index} requires telegramUserId`);
  }

  if (!id && !telegramUserId) {
    throw new Error(
      `Bootstrap user at index ${index} requires id or telegramUserId`,
    );
  }

  if (telegramUserId) {
    if (!/^\d{5,20}$/.test(telegramUserId)) {
      throw new Error(`Bootstrap user at index ${index} has invalid telegramUserId`);
    }

    if (placeholderTelegramIds.has(telegramUserId)) {
      throw new Error(`Bootstrap user at index ${index} has placeholder telegramUserId`);
    }
  }

  return {
    ...(id ? { id } : {}),
    role,
    displayName,
    ...(telegramUserId ? { telegramUserId } : {}),
    timezone: String(user.timezone ?? defaultTimezone).trim() || defaultTimezone,
  };
}

export function parseBootstrapUsers(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${bootstrapUsersEnvName} must be valid JSON`, { cause: error });
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${bootstrapUsersEnvName} must be a JSON array`);
  }

  const users = parsed.map(normalizeUser);
  const telegramIds = new Set();
  const ids = new Set();

  for (const user of users) {
    if (user.id) {
      if (ids.has(user.id)) {
        throw new Error(`${bootstrapUsersEnvName} contains duplicate user id`);
      }
      ids.add(user.id);
    }

    if (user.telegramUserId) {
      if (telegramIds.has(user.telegramUserId)) {
        throw new Error(`${bootstrapUsersEnvName} contains duplicate telegramUserId`);
      }
      telegramIds.add(user.telegramUserId);
    }
  }

  return users;
}

function upsertWhereForUser(user) {
  if (user.telegramUserId) {
    return { telegramUserId: user.telegramUserId };
  }

  return { id: user.id };
}

function maskTelegramUserId(telegramUserId) {
  if (!telegramUserId) {
    return null;
  }

  return `${telegramUserId.slice(0, 2)}...${telegramUserId.slice(-2)}`;
}

export async function bootstrapUsers({ prisma, users = [], allowWrites = false } = {}) {
  if (!prisma) {
    throw new Error("prisma client is required");
  }

  if (!allowWrites) {
    throw new Error(writeOptInMessage);
  }

  const normalizedUsers = users.map(normalizeUser);
  const bootstrapped = [];

  for (const user of normalizedUsers) {
    const persisted = await prisma.user.upsert({
      where: upsertWhereForUser(user),
      update: {
        role: user.role,
        displayName: user.displayName,
        telegramUserId: user.telegramUserId ?? null,
        timezone: user.timezone,
      },
      create: {
        ...user,
        id: user.id ?? `telegram-${user.telegramUserId}`,
      },
    });

    bootstrapped.push({
      id: persisted.id,
      role: persisted.role,
      displayName: persisted.displayName,
      telegramUserId: maskTelegramUserId(persisted.telegramUserId),
    });
  }

  return {
    count: bootstrapped.length,
    users: bootstrapped,
  };
}

export async function bootstrapUsersFromEnv({ prisma, env = process.env } = {}) {
  const users = parseBootstrapUsers(env?.[bootstrapUsersEnvName]);

  if (users.length === 0) {
    return { count: 0, users: [], skipped: true };
  }

  return bootstrapUsers({
    prisma,
    users,
    allowWrites: envAllowsWrites(env),
  });
}

export async function runBootstrapUsersCli({
  createClient = createPrismaClient,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
} = {}) {
  let prisma;

  try {
    const users = parseBootstrapUsers(env?.[bootstrapUsersEnvName]);
    if (users.length === 0) {
      throw new Error(`${bootstrapUsersEnvName} is empty`);
    }

    if (!envAllowsWrites(env)) {
      throw new Error(writeOptInMessage);
    }

    prisma = await createClient();
    const summary = await bootstrapUsers({ prisma, users, allowWrites: true });
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error?.message ?? String(error)}\n`);
    return 1;
  } finally {
    await prisma?.$disconnect?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBootstrapUsersCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
