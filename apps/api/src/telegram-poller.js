const defaultTelegramBaseUrl = "https://api.telegram.org";
const defaultAllowedUpdates = ["message"];
const webhookConflictPattern = /webhook/i;

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

function buildDeleteWebhookUrl({ baseUrl, botToken }) {
  return `${baseUrl.replace(/\/+$/, "")}/bot${botToken}/deleteWebhook`;
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function deleteWebhookBeforePolling({
  botKey,
  botToken,
  fetchImpl = fetch,
  baseUrl = defaultTelegramBaseUrl,
  dropPendingUpdates = false,
} = {}) {
  const response = await fetchImpl(
    buildDeleteWebhookUrl({ baseUrl, botToken }),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drop_pending_updates: Boolean(dropPendingUpdates) }),
    },
  );
  const body = await responseJson(response);

  if (!response.ok || body.ok === false) {
    const description = body.description ? `: ${body.description}` : "";
    throw new Error(`Telegram deleteWebhook failed for ${botKey} with ${response.status}${description}`);
  }

  return body;
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
      if (update?.update_id != null) {
        nextOffset = Math.max(Number(nextOffset ?? 0), Number(update.update_id) + 1);
      }
    } catch (error) {
      logger?.error?.("telegram polling update failed", {
        botKey,
        updateId: update?.update_id,
        errorMessage: error.message,
      });
      break;
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
  pollingStateRepository = null,
  clearWebhookBeforePolling = false,
  dropPendingUpdatesOnWebhookClear = false,
  workerId = `telegram-poller-${Math.random().toString(36).slice(2)}`,
  leaseMs = Math.max(60_000, (Number(timeoutSeconds) || 20) * 1000 + 30_000),
  logger = console,
} = {}) {
  let stopped = false;
  const offsets = {};
  const botEntries = Object.entries(botTokens).filter(([, botToken]) => botToken);

  const loops = botEntries.map(([botKey, botToken]) =>
    (async () => {
      let webhookCleared = !clearWebhookBeforePolling;

      while (!stopped) {
        try {
          if (!webhookCleared) {
            await deleteWebhookBeforePolling({
              botKey,
              botToken,
              fetchImpl,
              baseUrl,
              dropPendingUpdates: dropPendingUpdatesOnWebhookClear,
            });
            webhookCleared = true;
          }

          let pollingState = null;
          if (pollingStateRepository?.claimLease) {
            const lease = await pollingStateRepository.claimLease({
              botKey,
              workerId,
              leaseMs,
              now: new Date(),
            });

            pollingState = lease.state;
            if (!lease.claimed) {
              await delay(intervalMs);
              continue;
            }

            if (offsets[botKey] == null && pollingState?.offset != null) {
              offsets[botKey] = pollingState.offset;
            }
          } else if (pollingStateRepository?.get && offsets[botKey] == null) {
            pollingState = await pollingStateRepository.get(botKey);
            if (pollingState?.offset != null) {
              offsets[botKey] = pollingState.offset;
            }
          }

          const previousOffset = offsets[botKey];
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

          if (pollingStateRepository?.updateOffset && result.nextOffset !== previousOffset) {
            await pollingStateRepository.updateOffset({
              botKey,
              offset: result.nextOffset,
              lastUpdateId: result.nextOffset == null ? null : result.nextOffset - 1,
              now: new Date(),
            });
          } else if (pollingStateRepository?.heartbeat) {
            await pollingStateRepository.heartbeat({
              botKey,
              now: new Date(),
            });
          }
          await delay(intervalMs);
        } catch (error) {
          if (webhookConflictPattern.test(error.message ?? "")) {
            webhookCleared = !clearWebhookBeforePolling;
          }

          if (pollingStateRepository?.recordError) {
            try {
              await pollingStateRepository.recordError({
                botKey,
                error,
                now: new Date(),
              });
            } catch (recordError) {
              logger?.error?.("telegram polling state update failed", {
                botKey,
                errorMessage: recordError.message,
              });
            }
          }
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
