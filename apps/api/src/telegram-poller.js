const defaultTelegramBaseUrl = "https://api.telegram.org";
const defaultAllowedUpdates = ["message"];

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildGetUpdatesUrl({
  baseUrl,
  botToken,
  offset,
  timeoutSeconds,
  limit,
  allowedUpdates = defaultAllowedUpdates,
}) {
  const params = new URLSearchParams({
    timeout: String(timeoutSeconds),
    limit: String(limit),
    allowed_updates: JSON.stringify(allowedUpdates),
  });

  if (offset != null) {
    params.set("offset", String(offset));
  }

  return `${baseUrl.replace(/\/+$/, "")}/bot${botToken}/getUpdates?${params.toString()}`;
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function pollTelegramBotOnce({
  botKey,
  botToken,
  offset,
  fetchImpl = fetch,
  handleUpdate,
  baseUrl = defaultTelegramBaseUrl,
  timeoutSeconds = 20,
  limit = 10,
  logger = console,
} = {}) {
  if (!botKey) throw new Error("botKey is required");
  if (!botToken) throw new Error("botToken is required");
  if (typeof handleUpdate !== "function") throw new Error("handleUpdate is required");

  const response = await fetchImpl(
    buildGetUpdatesUrl({
      baseUrl,
      botToken,
      offset,
      timeoutSeconds,
      limit,
    }),
  );
  const body = await responseJson(response);

  if (!response.ok || body.ok === false) {
    const description = body.description ? `: ${body.description}` : "";
    throw new Error(`Telegram getUpdates failed with ${response.status}${description}`);
  }

  const updates = Array.isArray(body.result) ? body.result : [];
  let nextOffset = offset;

  for (const update of updates) {
    try {
      await handleUpdate(botKey, update);
    } catch (error) {
      logger?.error?.("telegram polling update failed", {
        botKey,
        updateId: update?.update_id,
        errorMessage: error.message,
      });
    } finally {
      if (update?.update_id != null) {
        nextOffset = Math.max(Number(nextOffset ?? 0), Number(update.update_id) + 1);
      }
    }
  }

  return {
    nextOffset,
    updateCount: updates.length,
  };
}

export function startTelegramPolling({
  botTokens = {},
  fetchImpl = fetch,
  handleUpdate,
  baseUrl = defaultTelegramBaseUrl,
  intervalMs = 1000,
  errorDelayMs = 5000,
  timeoutSeconds = 20,
  limit = 10,
  logger = console,
} = {}) {
  let stopped = false;
  const offsets = {};
  const botEntries = Object.entries(botTokens).filter(([, botToken]) => botToken);

  const loops = botEntries.map(([botKey, botToken]) =>
    (async () => {
      while (!stopped) {
        try {
          const result = await pollTelegramBotOnce({
            botKey,
            botToken,
            offset: offsets[botKey],
            fetchImpl,
            handleUpdate,
            baseUrl,
            timeoutSeconds,
            limit,
            logger,
          });
          offsets[botKey] = result.nextOffset;
          await delay(intervalMs);
        } catch (error) {
          logger?.error?.("telegram polling failed", {
            botKey,
            errorMessage: error.message,
          });
          await delay(errorDelayMs);
        }
      }
    })(),
  );

  return {
    stop() {
      stopped = true;
    },
    done: Promise.allSettled(loops),
    offsets,
  };
}
