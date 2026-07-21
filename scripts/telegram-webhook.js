import { fileURLToPath } from "node:url";

const defaultTelegramBaseUrl = "https://api.telegram.org";

function envValue(value) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function parseBoolean(value) {
  return ["1", "true", "yes"].includes(String(value ?? "").toLowerCase());
}

function publicBaseUrlFromEnv(env) {
  const value = envValue(env.APP_PUBLIC_URL) ?? envValue(env.APP_BASE_URL);
  if (!value) {
    throw new Error("APP_PUBLIC_URL is required to register Telegram webhook");
  }

  return value.replace(/\/+$/, "");
}

function botTokenFromEnv(env) {
  const token =
    envValue(env.TELEGRAM_BOT_TOKEN) ??
    envValue(env.TELEGRAM_FAMILY_BOT_TOKEN) ??
    envValue(env.TELEGRAM_OWNER_BOT_TOKEN) ??
    envValue(env.TELEGRAM_TEACHER_BOT_TOKEN);

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  return token;
}

async function parseTelegramResponse(response, methodName) {
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok || body.ok === false) {
    const detail = body.description ? `: ${body.description}` : "";
    throw new Error(`Telegram ${methodName} failed with ${response.status}${detail}`);
  }

  return body;
}

export function buildTelegramWebhookUrl(env = process.env) {
  return `${publicBaseUrlFromEnv(env)}/telegram/webhook`;
}

export async function callTelegramMethod({
  methodName,
  payload = {},
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (!methodName) {
    throw new Error("Telegram method name is required");
  }

  const token = botTokenFromEnv(env);
  const baseUrl = envValue(env.TELEGRAM_API_BASE_URL) ?? defaultTelegramBaseUrl;
  const response = await fetchImpl(`${baseUrl}/bot${token}/${methodName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  return parseTelegramResponse(response, methodName);
}

export async function setTelegramWebhook({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  await callTelegramMethod({
    methodName: "getMe",
    env,
    fetchImpl,
  });

  const payload = {
    url: buildTelegramWebhookUrl(env),
    allowed_updates: ["message"],
  };

  const secretToken = envValue(env.TELEGRAM_WEBHOOK_SECRET);
  if (secretToken) {
    payload.secret_token = secretToken;
  }

  if (parseBoolean(env.TELEGRAM_DROP_PENDING_UPDATES)) {
    payload.drop_pending_updates = true;
  }

  return callTelegramMethod({
    methodName: "setWebhook",
    payload,
    env,
    fetchImpl,
  });
}

export async function deleteTelegramWebhook({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return callTelegramMethod({
    methodName: "deleteWebhook",
    payload: {
      drop_pending_updates: parseBoolean(env.TELEGRAM_DROP_PENDING_UPDATES),
    },
    env,
    fetchImpl,
  });
}

export async function getTelegramWebhookInfo({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return callTelegramMethod({
    methodName: "getWebhookInfo",
    env,
    fetchImpl,
  });
}

export async function runTelegramWebhookCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  fetchImpl = fetch,
} = {}) {
  const action = argv[0] ?? "set";

  try {
    const result =
      action === "set"
        ? await setTelegramWebhook({ env, fetchImpl })
        : action === "delete"
          ? await deleteTelegramWebhook({ env, fetchImpl })
          : action === "info"
            ? await getTelegramWebhookInfo({ env, fetchImpl })
            : null;

    if (!result) {
      throw new Error("Usage: node scripts/telegram-webhook.js set|delete|info");
    }

    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error?.message ?? String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTelegramWebhookCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
