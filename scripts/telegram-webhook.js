import { fileURLToPath } from "node:url";

const defaultTelegramBaseUrl = "https://api.telegram.org";
const telegramBotKeys = ["owner", "daughter", "teacher"];
const telegramBotTokenEnv = {
  owner: "TELEGRAM_OWNER_BOT_TOKEN",
  daughter: "TELEGRAM_DAUGHTER_BOT_TOKEN",
  teacher: "TELEGRAM_TEACHER_BOT_TOKEN",
};

function envValue(value) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function parseBoolean(value) {
  return ["1", "true", "yes"].includes(String(value ?? "").toLowerCase());
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function publicBaseUrlFromEnv(env) {
  const value = envValue(env.APP_PUBLIC_URL) ?? envValue(env.APP_BASE_URL);
  if (!value) {
    throw new Error("APP_PUBLIC_URL is required to register Telegram webhook");
  }

  return value.replace(/\/+$/, "");
}

function botTokenFromEnv(env, botKey) {
  if (botKey) {
    const token = envValue(env[telegramBotTokenEnv[botKey]]);
    if (!token) {
      throw new Error(`TELEGRAM_${botKey.toUpperCase()}_BOT_TOKEN is required`);
    }

    return token;
  }

  const token =
    envValue(env.TELEGRAM_BOT_TOKEN) ??
    envValue(env.TELEGRAM_FAMILY_BOT_TOKEN) ??
    envValue(env.TELEGRAM_OWNER_BOT_TOKEN) ??
    envValue(env.TELEGRAM_DAUGHTER_BOT_TOKEN) ??
    envValue(env.TELEGRAM_TEACHER_BOT_TOKEN);

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  return token;
}

function telegramWebhookSecretFromEnv(env, botKey) {
  if (!botKey) {
    return envValue(env.TELEGRAM_WEBHOOK_SECRET);
  }

  return envValue(env[`TELEGRAM_${botKey.toUpperCase()}_WEBHOOK_SECRET`]) ??
    envValue(env.TELEGRAM_WEBHOOK_SECRET);
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

export function buildTelegramWebhookUrl(env = process.env, { botKey } = {}) {
  const baseUrl = publicBaseUrlFromEnv(env);
  return botKey
    ? `${baseUrl}/telegram/${botKey}/webhook`
    : `${baseUrl}/telegram/webhook`;
}

export async function callTelegramMethod({
  methodName,
  payload = {},
  botKey,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (!methodName) {
    throw new Error("Telegram method name is required");
  }

  const token = botTokenFromEnv(env, botKey);
  const baseUrl = envValue(env.TELEGRAM_API_BASE_URL) ?? defaultTelegramBaseUrl;
  const response = await fetchImpl(`${baseUrl}/bot${token}/${methodName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  return parseTelegramResponse(response, methodName);
}

export async function setTelegramWebhook({
  botKey,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  await callTelegramMethod({
    methodName: "getMe",
    botKey,
    env,
    fetchImpl,
  });

  const payload = {
    url: buildTelegramWebhookUrl(env, { botKey }),
    allowed_updates: ["message"],
    max_connections: parsePositiveInteger(env.TELEGRAM_WEBHOOK_MAX_CONNECTIONS, 1),
  };

  const secretToken = telegramWebhookSecretFromEnv(env, botKey);
  if (secretToken) {
    payload.secret_token = secretToken;
  }

  if (parseBoolean(env.TELEGRAM_DROP_PENDING_UPDATES)) {
    payload.drop_pending_updates = true;
  }

  return callTelegramMethod({
    methodName: "setWebhook",
    payload,
    botKey,
    env,
    fetchImpl,
  });
}

export async function deleteTelegramWebhook({
  botKey,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return callTelegramMethod({
    methodName: "deleteWebhook",
    payload: {
      drop_pending_updates: parseBoolean(env.TELEGRAM_DROP_PENDING_UPDATES),
    },
    botKey,
    env,
    fetchImpl,
  });
}

export async function getTelegramWebhookInfo({
  botKey,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  return callTelegramMethod({
    methodName: "getWebhookInfo",
    botKey,
    env,
    fetchImpl,
  });
}

function parseBotTarget(argv) {
  const explicitBot = argv.find((item) => item?.startsWith("--bot="))?.slice("--bot=".length);
  const positionalBot = argv.find((item, index) => index > 0 && !item?.startsWith("--"));
  const botTarget = explicitBot ?? positionalBot;

  if (!botTarget) {
    return { botKeys: [undefined] };
  }

  if (botTarget === "all") {
    return { botKeys: telegramBotKeys };
  }

  if (!telegramBotKeys.includes(botTarget)) {
    throw new Error(`Unknown Telegram bot target "${botTarget}"`);
  }

  return { botKeys: [botTarget] };
}

async function runWebhookActionForBot({ action, botKey, env, fetchImpl }) {
  const result =
    action === "set"
      ? await setTelegramWebhook({ botKey, env, fetchImpl })
      : action === "delete"
        ? await deleteTelegramWebhook({ botKey, env, fetchImpl })
        : action === "info"
          ? await getTelegramWebhookInfo({ botKey, env, fetchImpl })
          : null;

  if (!result) {
    throw new Error("Usage: node scripts/telegram-webhook.js set|delete|info [owner|daughter|teacher|all]");
  }

  return {
    botKey: botKey ?? "default",
    result,
  };
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
    const { botKeys } = parseBotTarget(argv);
    const result = [];
    for (const botKey of botKeys) {
      result.push(await runWebhookActionForBot({ action, botKey, env, fetchImpl }));
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
