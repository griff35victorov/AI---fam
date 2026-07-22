const telegramBotKeys = new Set(["owner", "daughter", "teacher"]);
const telegramBotTokenEnv = {
  owner: "TELEGRAM_OWNER_BOT_TOKEN",
  daughter: "TELEGRAM_DAUGHTER_BOT_TOKEN",
  teacher: "TELEGRAM_TEACHER_BOT_TOKEN",
};
const defaultTelegramBaseUrl = "https://api.telegram.org";

function envValue(value) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

function parseTelegramRoute(pathname) {
  const match = pathname.match(/^\/telegram\/([^/]+)\/webhook\/?$/);
  if (!match) return null;

  const botKey = match[1];
  return telegramBotKeys.has(botKey) ? { botKey } : null;
}

function parseTelegramSendRoute(pathname) {
  const match = pathname.match(/^\/telegram\/([^/]+)\/send\/?$/);
  if (!match) return null;

  const botKey = match[1];
  return telegramBotKeys.has(botKey) ? { botKey } : null;
}

function webhookSecretFromEnv(env, botKey) {
  return envValue(env[`TELEGRAM_${botKey.toUpperCase()}_WEBHOOK_SECRET`]);
}

function botTokenFromEnv(env, botKey) {
  return envValue(env[telegramBotTokenEnv[botKey]]);
}

function relaySecretFromEnv(env) {
  return envValue(env.TELEGRAM_RELAY_SECRET);
}

function timewebBaseUrlFromEnv(env) {
  const value =
    envValue(env.TIMEWEB_APP_URL) ??
    envValue(env.TIMEWEB_PUBLIC_URL) ??
    envValue(env.TIMEWEB_CORE_URL);

  if (!value) {
    throw new Error("TIMEWEB_APP_URL is required");
  }

  return value.replace(/\/+$/, "");
}

function buildTimewebWebhookUrl(env, botKey) {
  return `${timewebBaseUrlFromEnv(env)}/telegram/${botKey}/webhook`;
}

function fallbackTelegramResponse(update, env) {
  const chatId = update?.message?.chat?.id;
  if (chatId === undefined || chatId === null) {
    return { ok: true };
  }

  return {
    method: "sendMessage",
    chat_id: chatId,
    text: envValue(env.RELAY_ACK_TEXT) ?? "Запрос получен.",
  };
}

function isUsableTelegramWebhookBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return typeof body.method === "string";
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function sendTelegramMessage({ env, botKey, body, fetchImpl }) {
  const botToken = botTokenFromEnv(env, botKey);
  if (!botToken) {
    return json({ error: "telegram_bot_token_not_configured" }, 500);
  }

  const chatId = body.chat_id ?? body.chatId;
  const text = body.text;
  if (chatId === undefined || chatId === null || typeof text !== "string" || text.length === 0) {
    return json({ error: "invalid_send_message" }, 400);
  }

  const chunks = splitTelegramMessageText(text);
  const results = [];
  for (const chunk of chunks) {
    const response = await sendTelegramMessageChunk({
      env,
      botKey,
      botToken,
      chatId,
      text: chunk,
      fetchImpl,
    });
    if (response.status !== 200) {
      if (results.length > 0) {
        return json({ error: "telegram_partial_delivery_failed" }, 409);
      }

      return response;
    }

    results.push(await responseJson(response));
  }

  return json(
    results.length === 1
      ? results[0]
      : { ok: true, result: results.map((result) => result.result ?? result) },
  );
}

async function sendTelegramMessageChunk({ env, botKey, botToken, chatId, text, fetchImpl }) {
  const baseUrl = (envValue(env.TELEGRAM_API_BASE_URL) ?? defaultTelegramBaseUrl).replace(/\/+$/, "");
  const maxAttempts = Math.max(1, parseInteger(env.TELEGRAM_SEND_MAX_ATTEMPTS, 3));
  const retryDelayMs = parseInteger(env.TELEGRAM_SEND_RETRY_DELAY_MS, 500);
  let responseBody = {};

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${baseUrl}/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildTelegramSendMessageBody({ chatId, text })),
      });
      responseBody = await responseJson(response);

      if (response.ok && responseBody.ok !== false) {
        return json(responseBody);
      }

      if (!telegramStatusIsRetryable(response.status) || attempt === maxAttempts) {
        return json({ error: "telegram_send_failed" }, 502);
      }
    } catch {
      if (attempt === maxAttempts) {
        return json({ error: "telegram_send_failed" }, 502);
      }
    }

    await sleep(retryDelayMs);
  }

  return json({ error: "telegram_send_failed" }, 502);
}

function telegramStatusIsRetryable(status) {
  return status === 429 || status >= 500;
}

function buildTelegramSendMessageBody({ chatId, text }) {
  return {
    chat_id: chatId,
    text,
    ...(hasUrl(text) ? { link_preview_options: { is_disabled: true } } : {}),
  };
}

const telegramTextLimit = 4096;
const telegramSafeTextLimit = 3900;

function splitTelegramMessageText(text, limit = telegramSafeTextLimit) {
  const normalizedText = String(text ?? "").trim();
  if (!normalizedText) {
    return [""];
  }

  const maxLength = Math.min(telegramTextLimit, Math.max(500, Number(limit) || telegramSafeTextLimit));
  if (normalizedText.length <= maxLength) {
    return [normalizedText];
  }

  const chunks = [];
  let remaining = normalizedText;
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength);
    const newlineIndex = window.lastIndexOf("\n");
    const spaceIndex = window.lastIndexOf(" ");
    const splitIndex =
      newlineIndex >= Math.floor(maxLength * 0.6)
        ? newlineIndex
        : spaceIndex >= Math.floor(maxLength * 0.6)
          ? spaceIndex
          : maxLength;

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function hasUrl(text) {
  return /https?:\/\/\S+/i.test(String(text ?? ""));
}

async function forwardToTimeweb({
  url,
  secret,
  bodyText,
  fetchImpl,
  timeoutMs,
  relayUpstreamSecret,
}) {
  const controller = new AbortController();
  const timeoutId =
    timeoutMs > 0
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : undefined;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": secret,
        ...(envValue(relayUpstreamSecret)
          ? { "x-family-ai-relay-secret": relayUpstreamSecret }
          : {}),
      },
      body: bodyText,
      signal: controller.signal,
    });
    const body = await responseJson(response);

    if (!response.ok) {
      const error = new Error(`Timeweb webhook failed with ${response.status}`);
      error.statusCode = response.status;
      error.body = body;
      throw error;
    }

    return body;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryForwardToTimeweb({
  url,
  secret,
  bodyText,
  fetchImpl,
  retries,
  timeoutMs,
  retryDelayMs,
  relayUpstreamSecret,
}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) {
      await sleep(retryDelayMs);
    }

    try {
      await forwardToTimeweb({
        url,
        secret,
        bodyText,
        fetchImpl,
        timeoutMs,
        relayUpstreamSecret,
      });
      return true;
    } catch {
      // Telegram has already received a fast response. Retries stay silent.
    }
  }

  return false;
}

function scheduleBackgroundRetry({ ctx, task }) {
  const safeTask = task.catch(() => undefined);
  if (typeof ctx?.waitUntil === "function") {
    ctx.waitUntil(safeTask);
    return;
  }

  safeTask.catch(() => undefined);
}

export async function handleRelayRequest(
  request,
  env = {},
  ctx = {},
  { fetchImpl = fetch } = {},
) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "telegram-relay" });
  }

  const sendRoute = parseTelegramSendRoute(url.pathname);
  if (request.method === "POST" && sendRoute) {
    const relaySecret = relaySecretFromEnv(env);
    if (!relaySecret) {
      return json({ error: "relay_secret_not_configured" }, 500);
    }

    if (request.headers.get("x-family-ai-relay-secret") !== relaySecret) {
      return json({ error: "relay_secret_invalid" }, 401);
    }

    let sendBody;
    try {
      sendBody = JSON.parse(await request.text());
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    return sendTelegramMessage({
      env,
      botKey: sendRoute.botKey,
      body: sendBody,
      fetchImpl,
    });
  }

  const route = parseTelegramRoute(url.pathname);
  if (request.method !== "POST" || !route) {
    return json({ error: "not_found" }, 404);
  }

  const secret = webhookSecretFromEnv(env, route.botKey);
  if (!secret) {
    return json({ error: "telegram_webhook_secret_not_configured" }, 500);
  }

  const receivedSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (receivedSecret !== secret) {
    return json({ error: "telegram_webhook_secret_invalid" }, 401);
  }

  const bodyText = await request.text();
  let update;
  try {
    update = JSON.parse(bodyText);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const timewebUrl = buildTimewebWebhookUrl(env, route.botKey);
  const relayUpstreamSecret = envValue(env.TELEGRAM_RELAY_UPSTREAM_SECRET);
  const responseTimeoutMs = parseInteger(env.TIMEWEB_RESPONSE_TIMEOUT_MS, 1200);
  const backgroundTimeoutMs = parseInteger(env.TIMEWEB_BACKGROUND_TIMEOUT_MS, 5000);
  const retries = parseInteger(env.TIMEWEB_FORWARD_RETRIES, 2);
  const retryDelayMs = parseInteger(env.TIMEWEB_FORWARD_RETRY_DELAY_MS, 250);

  try {
    const timewebBody = await forwardToTimeweb({
      url: timewebUrl,
      secret,
      bodyText,
      fetchImpl,
      timeoutMs: responseTimeoutMs,
      relayUpstreamSecret,
    });

    if (isUsableTelegramWebhookBody(timewebBody)) {
      return json(timewebBody);
    }
  } catch {
    if (retries > 0) {
      scheduleBackgroundRetry({
        ctx,
        task: retryForwardToTimeweb({
          url: timewebUrl,
          secret,
          bodyText,
          fetchImpl,
          retries,
          timeoutMs: backgroundTimeoutMs,
          retryDelayMs,
          relayUpstreamSecret,
        }),
      });
    }
  }

  return json(fallbackTelegramResponse(update, env));
}

export default {
  fetch(request, env, ctx) {
    return handleRelayRequest(request, env, ctx);
  },
};
