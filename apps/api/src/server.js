import { createServer } from "node:http";

import {
  bootstrapUsersFromEnv,
  createPrismaClient,
} from "../../../packages/db/src/index.js";
import { createHealthResponse } from "./health.js";
import { handleOrchestratorRequest } from "./orchestrator.js";
import { createProductionDependencies } from "./production-runtime.js";
import { startReminderDispatcher } from "./reminder-dispatcher.js";
import {
  createRepositoryBackedOrchestrator,
  isImmediateRepositoryBackedRequest,
} from "./runtime.js";
import { startSupervisorLoop } from "./supervisor-runner.js";
import { startTelegramPolling } from "./telegram-poller.js";
import {
  accessNotConfiguredText,
  accessNotConfiguredTextForRequest,
  buildTelegramRequest,
  buildTelegramRequestFromRepositories,
  handleTelegramUpdate,
  startCommandText,
  telegramUpdateDedupeKeyPart,
} from "./telegram.js";

const telegramAcceptedText = "Принял. Готовлю ответ отдельным сообщением.";
const telegramConnectivityText =
  "Связь установлена. Telegram gateway, App Platform и оркестр отвечают. Если запрос требует AI или инструмента, финальный ответ придет отдельным сообщением.";
const urlPattern = /https?:\/\/\S+/i;
const defaultTelegramAcceptedAckThrottleMs = 8000;

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "connection": "close",
  });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorizeTelegramWebhookRequest({
  request,
  routeSecret,
  relayWebhookSecret,
  requireWebhookSecret,
  webhookIngressMode = "direct_or_relay",
}) {
  if (!routeSecret) {
    return requireWebhookSecret
      ? { ok: false, statusCode: 503, error: "telegram_webhook_secret_not_configured" }
      : { ok: true };
  }

  if (request.headers["x-telegram-bot-api-secret-token"] !== routeSecret) {
    return { ok: false, statusCode: 401, error: "telegram_webhook_secret_invalid" };
  }

  const receivedRelaySecret = request.headers["x-family-ai-relay-secret"];
  if (
    webhookIngressMode === "relay" &&
    relayWebhookSecret &&
    receivedRelaySecret !== relayWebhookSecret
  ) {
    return { ok: false, statusCode: 401, error: "relay_secret_required" };
  }

  if (relayWebhookSecret && receivedRelaySecret && receivedRelaySecret !== relayWebhookSecret) {
    return { ok: false, statusCode: 401, error: "relay_secret_invalid" };
  }

  return { ok: true };
}

function parseTelegramWebhookRoute(url) {
  if (url === "/telegram/webhook") {
    return { botKey: undefined };
  }

  const match = url?.match(/^\/telegram\/(owner|daughter|teacher)\/webhook$/);
  if (!match) {
    return null;
  }

  return { botKey: match[1] };
}

function resolveTelegramSender({ botKey, telegramSender, telegramSenders }) {
  if (!botKey) {
    return telegramSender;
  }

  return telegramSenders?.[botKey];
}

function resolveTelegramBackgroundSender({
  botKey,
  telegramSender,
  telegramSenders,
  telegramBackgroundSender,
  telegramBackgroundSenders,
}) {
  return (
    resolveTelegramSender({
      botKey,
      telegramSender: telegramBackgroundSender,
      telegramSenders: telegramBackgroundSenders,
    }) ??
    resolveTelegramSender({
      botKey,
      telegramSender,
      telegramSenders,
    })
  );
}

function resolveVoiceTranscriber({ botKey, voiceTranscriber, voiceTranscribers }) {
  if (!botKey) {
    return voiceTranscriber;
  }

  return voiceTranscribers?.[botKey] ?? voiceTranscriber;
}

function resolveImageOcr({ botKey, imageOcr, imageOcrs }) {
  if (!botKey) {
    return imageOcr;
  }

  return imageOcrs?.[botKey] ?? imageOcr;
}

function resolveDocumentTextExtractor({
  botKey,
  documentTextExtractor,
  documentTextExtractors,
}) {
  if (!botKey) {
    return documentTextExtractor;
  }

  return documentTextExtractors?.[botKey] ?? documentTextExtractor;
}

function resolveTelegramWebhookSecret({ botKey, telegramWebhookSecret, telegramWebhookSecrets }) {
  if (!botKey) {
    return telegramWebhookSecret;
  }

  return telegramWebhookSecrets?.[botKey];
}

function buildTelegramWebhookResponse(result, replyMode) {
  if (replyMode !== "webhook_response") {
    return { ok: true, ...result };
  }

  if (!result?.chatId || !result?.text) {
    return { ok: true };
  }

  return {
    method: "sendMessage",
    chat_id: result.chatId,
    text: result.text,
    ...(urlPattern.test(result.text)
      ? { link_preview_options: { is_disabled: true } }
      : {}),
  };
}

function buildWebhookOkResponse() {
  return { ok: true };
}

function normalizeTelegramCommandText(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[?!.,]+$/g, "");
}

function isTelegramConnectivityCheckText(text) {
  const normalized = normalizeTelegramCommandText(text);
  return (
    normalized === "/ping" ||
    normalized === "ping" ||
    normalized === "пинг" ||
    normalized === "проверка" ||
    normalized === "проверка связи" ||
    normalized === "связь" ||
    normalized === "статус связи"
  );
}

function buildAcceptedTelegramWebhookResponse(telegramRequest) {
  return buildTelegramWebhookResponse(
    {
      chatId: telegramRequest?.chatId,
      text: telegramAcceptedText,
    },
    "webhook_response",
  );
}

function buildConnectivityTelegramWebhookResponse(telegramRequest) {
  return buildTelegramWebhookResponse(
    {
      chatId: telegramRequest?.chatId,
      text: telegramConnectivityText,
    },
    "webhook_response",
  );
}

function buildSilentTelegramWebhookResponse(telegramRequest) {
  const chatId = telegramRequest?.chatId;
  if (!chatId) {
    return buildWebhookOkResponse();
  }

  return {
    method: "sendChatAction",
    chat_id: chatId,
    action: "typing",
  };
}

function telegramAcceptedAckThrottleKey(telegramRequest) {
  const chatId = telegramRequest?.chatId;
  if (!chatId) return null;

  return `${telegramRequest?.telegramBotKey ?? "default"}:${chatId}`;
}

function shouldSendVisibleTelegramAcceptedAck({
  telegramRequest,
  ackTimestamps,
  throttleMs = defaultTelegramAcceptedAckThrottleMs,
  nowMs = Date.now(),
} = {}) {
  if (!ackTimestamps || throttleMs <= 0) {
    return true;
  }

  const key = telegramAcceptedAckThrottleKey(telegramRequest);
  if (!key) {
    return true;
  }

  const previous = ackTimestamps.get(key);
  ackTimestamps.set(key, nowMs);
  return !Number.isFinite(previous) || nowMs - previous >= throttleMs;
}

function buildScheduledTelegramWebhookResponse(
  telegramRequest,
  scheduleResult,
  {
    ackTimestamps,
    ackThrottleMs = defaultTelegramAcceptedAckThrottleMs,
  } = {},
) {
  return scheduleResult?.duplicate
    ? buildSilentTelegramWebhookResponse(telegramRequest)
    : shouldSendVisibleTelegramAcceptedAck({
        telegramRequest,
        ackTimestamps,
        throttleMs: ackThrottleMs,
      })
      ? buildAcceptedTelegramWebhookResponse(telegramRequest)
      : buildSilentTelegramWebhookResponse(telegramRequest);
}

function buildTelegramDeliveryNotConfiguredWebhookResponse(telegramRequest) {
  return buildTelegramWebhookResponse(
    {
      chatId: telegramRequest?.chatId,
      text:
        "\u0414\u043e\u0441\u0442\u0430\u0432\u043a\u0430 \u0444\u0438\u043d\u0430\u043b\u044c\u043d\u044b\u0445 Telegram-\u043e\u0442\u0432\u0435\u0442\u043e\u0432 \u043d\u0435 \u043d\u0430\u0441\u0442\u0440\u043e\u0435\u043d\u0430. \u041d\u0443\u0436\u0435\u043d Telegram relay \u0438\u043b\u0438 \u044f\u0432\u043d\u044b\u0439 direct debug-\u0440\u0435\u0436\u0438\u043c.",
    },
    "webhook_response",
  );
}

async function buildTelegramWebhookRequest(
  body,
  {
    users,
    repositories,
    botKey,
    voiceTranscriber,
    imageOcr,
    documentTextExtractor,
    deferMediaProcessing = false,
  },
) {
  return repositories?.users
    ? buildTelegramRequestFromRepositories(body, {
        repositories,
        botKey,
        voiceTranscriber,
        imageOcr,
        documentTextExtractor,
        deferMediaProcessing,
      })
    : buildTelegramRequest(body, { users, botKey });
}

function buildImmediateTelegramWebhookResponse(telegramRequest) {
  const chatId = telegramRequest?.chatId;
  if (!chatId) {
    return { ok: true };
  }

  return buildTelegramWebhookResponse(
    {
      chatId,
      text: telegramRequest.rejected
        ? accessNotConfiguredTextForRequest(telegramRequest)
        : telegramRequest.voiceRejected
          ? telegramRequest.voiceReplyText
        : telegramRequest.imageRejected
          ? telegramRequest.imageReplyText
        : telegramRequest.documentRejected
          ? telegramRequest.documentReplyText
        : telegramRequest.isStartCommand
          ? startCommandText
          : telegramAcceptedText,
    },
    "webhook_response",
  );
}

function telegramBackgroundUpdateKey(update, botKey) {
  const keyPart = telegramUpdateDedupeKeyPart(update);
  if (!keyPart) {
    return null;
  }

  return `${botKey ?? "default"}:${keyPart}`;
}

function telegramReplyDeliveryKey(update, botKey) {
  const keyPart = telegramUpdateDedupeKeyPart(update);
  if (!keyPart) {
    return null;
  }

  return `telegram:${botKey ?? "default"}:${keyPart}:reply`;
}

function telegramUpdateJobKey(update, botKey) {
  const keyPart = telegramUpdateDedupeKeyPart(update);
  if (!keyPart) {
    return null;
  }

  return `telegram-update:${botKey ?? "default"}:${keyPart}`;
}

function isRetryableTelegramDelivery(delivery, now = new Date()) {
  if (delivery?.status === "failed" && delivery?.result?.stage !== "send") {
    return true;
  }

  return (
    delivery?.status === "running" &&
    delivery.result?.stage === "processing" &&
    delivery.lockedUntil != null &&
    new Date(delivery.lockedUntil).getTime() <= new Date(now).getTime()
  );
}

async function telegramReplySendWasAttempted({ repositories, update, botKey }) {
  const key = telegramReplyDeliveryKey(update, botKey);
  if (!key || typeof repositories?.telegramDeliveries?.get !== "function") {
    return false;
  }

  const delivery = await repositories.telegramDeliveries.get(key);
  return (
    delivery?.status === "completed" ||
    delivery?.result?.stage === "send" ||
    delivery?.result?.stage === "sent"
  );
}

function telegramUpdateRetryRunAt({ now = new Date(), attempts = 1, retryDelayMs = 5000 } = {}) {
  const delayMs = Math.max(0, Number(retryDelayMs) || 0) * Math.max(1, Number(attempts) || 1);
  return new Date(new Date(now).getTime() + delayMs);
}

async function isTelegramReplyDeliveryDuplicate({ repositories, update, botKey } = {}) {
  const key = telegramReplyDeliveryKey(update, botKey);
  if (!key || typeof repositories?.telegramDeliveries?.get !== "function") {
    return false;
  }

  const delivery = await repositories.telegramDeliveries.get(key);
  return Boolean(delivery && !isRetryableTelegramDelivery(delivery));
}

function telegramChatIdFromUpdate(update) {
  const chatId = update?.message?.chat?.id;
  return chatId === undefined || chatId === null ? null : chatId;
}

function telegramTextFromUpdate(update) {
  return update?.message?.text ?? update?.message?.caption ?? "";
}

function isTelegramStartCommandText(text) {
  return String(text ?? "").trim().toLowerCase() === "/start";
}

function buildRawQueuedTelegramRequest(update, botKey) {
  return {
    chatId: telegramChatIdFromUpdate(update),
    telegramBotKey: botKey,
  };
}

function logTelegramBackgroundError(error) {
  console.error("telegram background handling failed", error);
}

function sendBackgroundChatAction({ telegramSender, body }) {
  if (typeof telegramSender?.sendChatAction !== "function") {
    return;
  }

  const chatId = telegramChatIdFromUpdate(body);
  if (!chatId) {
    return;
  }

  Promise.resolve(telegramSender.sendChatAction({ chatId, action: "typing" })).catch(
    logTelegramBackgroundError,
  );
}

function runTelegramBackgroundUpdate({
  body,
  users,
  repositories,
  orchestrator,
  telegramSender,
  botKey,
  voiceTranscriber,
  imageOcr,
  documentTextExtractor,
  backgroundKey,
  telegramBackgroundUpdates,
}) {
  sendBackgroundChatAction({ telegramSender, body });

  handleTelegramUpdate(body, {
    users,
    repositories,
    orchestrator,
    telegramSender,
    voiceTranscriber,
    imageOcr,
    documentTextExtractor,
    botKey,
  })
    .catch(logTelegramBackgroundError)
    .finally(() => {
      if (backgroundKey) {
        telegramBackgroundUpdates.delete(backgroundKey);
      }
    });
}

async function enqueueTelegramUpdateJob({ repositories, update, botKey, now = new Date() }) {
  const key = telegramUpdateJobKey(update, botKey);
  if (!key || typeof repositories?.jobs?.enqueue !== "function") {
    return null;
  }

  const job = await repositories.jobs.enqueue({
    type: "telegram-update",
    payload: {
      botKey: botKey ?? null,
      update,
    },
    status: "queued",
    runAt: now,
    dedupeKey: key,
  });

  if (
    job?.status === "failed" &&
    job.result?.sendWasAttempted !== true &&
    typeof repositories.jobs.rescheduleJob === "function"
  ) {
    return repositories.jobs.rescheduleJob(
      job,
      {
        status: "redelivery_requeued",
        previousStatus: job.status,
        previousError: job.error ?? job.result?.error ?? null,
        updateId: update.update_id ?? null,
        botKey: botKey ?? "default",
      },
      now,
      now,
    );
  }

  return job;
}

function enqueueTelegramUpdateJobInBackground({
  repositories,
  update,
  botKey,
  triggerTelegramUpdateDispatcher,
}) {
  Promise.resolve()
    .then(() => enqueueTelegramUpdateJob({ repositories, update, botKey }))
    .then((job) => {
      if (job) {
        triggerTelegramUpdateDispatcher?.();
      }
    })
    .catch(logTelegramBackgroundError);
}

async function scheduleTelegramBackgroundUpdate({
  body,
  users,
  repositories,
  orchestrator,
  telegramSender,
  botKey,
  voiceTranscriber,
  imageOcr,
  documentTextExtractor,
  telegramBackgroundDelayMs,
  telegramBackgroundUpdates,
  telegramUpdateQueueEnabled,
  triggerTelegramUpdateDispatcher,
}) {
  if (await isTelegramReplyDeliveryDuplicate({ repositories, update: body, botKey })) {
    return { duplicate: true };
  }

  if (
    telegramUpdateQueueEnabled &&
    typeof repositories?.jobs?.enqueue === "function" &&
    telegramUpdateJobKey(body, botKey)
  ) {
    await enqueueTelegramUpdateJob({ repositories, update: body, botKey });
    triggerTelegramUpdateDispatcher?.();
    return { queued: true };
  }

  const backgroundKey = telegramBackgroundUpdateKey(body, botKey);
  let reservedBackgroundKey = false;
  if (backgroundKey) {
    if (telegramBackgroundUpdates.has(backgroundKey)) {
      return { duplicate: true };
    }
    telegramBackgroundUpdates.add(backgroundKey);
    reservedBackgroundKey = true;
  }

  setTimeout(() => {
    runTelegramBackgroundUpdate({
      body,
      users,
      repositories,
      orchestrator,
      telegramSender,
      voiceTranscriber,
      imageOcr,
      documentTextExtractor,
      botKey,
      backgroundKey,
      telegramBackgroundUpdates,
    });
  }, telegramBackgroundDelayMs);

  return { queued: false };
}

export async function dispatchTelegramUpdateJobsOnce({
  repositories,
  users,
  orchestrator,
  telegramSender,
  telegramSenders = {},
  telegramBackgroundSender,
  telegramBackgroundSenders = {},
  voiceTranscriber,
  voiceTranscribers = {},
  imageOcr,
  imageOcrs = {},
  documentTextExtractor,
  documentTextExtractors = {},
  now = new Date(),
  maxJobs = 10,
  maxAttempts = 3,
  retryDelayMs = 5000,
} = {}) {
  if (typeof repositories?.jobs?.claim !== "function") {
    return { status: "disabled", processed: 0 };
  }

  let processed = 0;
  for (let index = 0; index < maxJobs; index += 1) {
    const job = await repositories.jobs.claim({
      workerId: "api-telegram-update-dispatcher",
      now,
      lockMs: 10 * 60_000,
      type: "telegram-update",
      dedupeKey: null,
    });
    if (!job) break;

    const payload = job.payload ?? {};
    const botKey = payload.botKey ?? undefined;
    const update = payload.update;

    try {
      if (!update) {
        throw new Error("Queued Telegram update job has no update payload");
      }

      const sender = resolveTelegramBackgroundSender({
        botKey,
        telegramSender,
        telegramSenders,
        telegramBackgroundSender,
        telegramBackgroundSenders,
      });
      if (!sender?.sendMessage) {
        throw new Error("Telegram sender is not configured for queued update");
      }

      sendBackgroundChatAction({ telegramSender: sender, body: update });

      const result = await handleTelegramUpdate(update, {
        users,
        repositories,
        orchestrator,
        telegramSender: sender,
        voiceTranscriber: resolveVoiceTranscriber({
          botKey,
          voiceTranscriber,
          voiceTranscribers,
        }),
        imageOcr: resolveImageOcr({
          botKey,
          imageOcr,
          imageOcrs,
        }),
        documentTextExtractor: resolveDocumentTextExtractor({
          botKey,
          documentTextExtractor,
          documentTextExtractors,
        }),
        botKey,
      });

      await repositories.jobs.completeJob(job, {
        status: "completed",
        botKey: botKey ?? "default",
        updateId: update.update_id ?? null,
        duplicate: Boolean(result?.duplicate),
      }, now);
    } catch (error) {
      const attempts = Number(job.attempts ?? 1);
      const sendWasAttempted = await telegramReplySendWasAttempted({
        repositories,
        update,
        botKey,
      });
      const canRetry =
        attempts < Math.max(1, Number(maxAttempts) || 1) &&
        !sendWasAttempted &&
        typeof repositories.jobs.rescheduleJob === "function";
      const failureResult = {
        status: "failed",
        error: error.message,
        botKey: botKey ?? "default",
        updateId: update?.update_id ?? null,
        attempts,
        sendWasAttempted,
      };

      if (canRetry) {
        await repositories.jobs.rescheduleJob(
          job,
          {
            ...failureResult,
            status: "retry_scheduled",
            retryAt: telegramUpdateRetryRunAt({ now, attempts, retryDelayMs }).toISOString(),
          },
          telegramUpdateRetryRunAt({ now, attempts, retryDelayMs }),
          now,
        );
      } else {
        await repositories.jobs.failJob(job, failureResult, now);
      }
    }

    processed += 1;
  }

  return { status: "ok", processed };
}

function startTelegramUpdateDispatcher(options = {}) {
  const intervalMs = options.intervalMs ?? 1000;
  let running = false;
  let rerunRequested = false;

  const tick = async () => {
    if (running) {
      rerunRequested = true;
      return;
    }

    running = true;
    try {
      do {
        rerunRequested = false;
        await dispatchTelegramUpdateJobsOnce(options);
      } while (rerunRequested);
    } catch (error) {
      console.error("telegram update dispatcher failed", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  return {
    stop() {
      clearInterval(timer);
    },
    trigger() {
      void tick();
    },
  };
}

function envValue(value) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

export function createAppServer(options = {}) {
  const dependencies = options.dependencies ?? {};
  const repositories = options.repositories ?? dependencies.repositories;
  const telegramSender = options.telegramSender ?? dependencies.telegramSender;
  const telegramSenders = options.telegramSenders ?? dependencies.telegramSenders ?? {};
  const telegramBackgroundSender =
    options.telegramBackgroundSender ?? dependencies.telegramBackgroundSender;
  const telegramBackgroundSenders =
    options.telegramBackgroundSenders ?? dependencies.telegramBackgroundSenders ?? {};
  const voiceTranscriber = options.voiceTranscriber ?? dependencies.voiceTranscriber;
  const voiceTranscribers =
    options.voiceTranscribers ?? dependencies.voiceTranscribers ?? {};
  const imageOcr = options.imageOcr ?? dependencies.imageOcr;
  const imageOcrs = options.imageOcrs ?? dependencies.imageOcrs ?? {};
  const documentTextExtractor =
    options.documentTextExtractor ?? dependencies.documentTextExtractor;
  const documentTextExtractors =
    options.documentTextExtractors ?? dependencies.documentTextExtractors ?? {};
  const telegramWebhookSecret =
    options.telegramWebhookSecret ?? dependencies.telegramWebhookSecret;
  const telegramWebhookSecrets =
    options.telegramWebhookSecrets ?? dependencies.telegramWebhookSecrets ?? {};
  const telegramRelayWebhookSecret =
    options.telegramRelayWebhookSecret ?? dependencies.telegramRelayWebhookSecret;
  const telegramWebhookIngressMode =
    options.telegramWebhookIngressMode ??
    dependencies.telegramWebhookIngressMode ??
    "direct_or_relay";
  const telegramRequireWebhookSecret =
    options.telegramRequireWebhookSecret ??
    dependencies.telegramRequireWebhookSecret ??
    false;
  const telegramReplyMode =
    options.telegramReplyMode ?? dependencies.telegramReplyMode ?? "send_message";
  const telegramPollingEnabled =
    options.telegramPollingEnabled ?? dependencies.telegramPollingEnabled ?? false;
  const telegramPollingBotTokens =
    options.telegramPollingBotTokens ?? dependencies.telegramPollingBotTokens ?? {};
  const telegramPollingFetchImpl =
    options.telegramPollingFetchImpl ?? dependencies.telegramPollingFetchImpl ?? fetch;
  const telegramPollingIntervalMs =
    options.telegramPollingIntervalMs ?? dependencies.telegramPollingIntervalMs ?? 1000;
  const telegramPollingErrorDelayMs =
    options.telegramPollingErrorDelayMs ?? dependencies.telegramPollingErrorDelayMs ?? 5000;
  const telegramPollingTimeoutSeconds =
    options.telegramPollingTimeoutSeconds ?? dependencies.telegramPollingTimeoutSeconds ?? 20;
  const telegramPollingStateRepository =
    options.telegramPollingStateRepository ??
    dependencies.telegramPollingStateRepository ??
    repositories?.telegramPollingStates;
  const telegramPollingClearWebhookEnabled =
    options.telegramPollingClearWebhookEnabled ??
    dependencies.telegramPollingClearWebhookEnabled ??
    false;
  const telegramBackgroundDelayMs =
    options.telegramBackgroundDelayMs ?? dependencies.telegramBackgroundDelayMs ?? 0;
  const telegramAcceptedAckThrottleMs =
    options.telegramAcceptedAckThrottleMs ??
    dependencies.telegramAcceptedAckThrottleMs ??
    defaultTelegramAcceptedAckThrottleMs;
  const telegramUpdateQueueEnabled =
    options.telegramUpdateQueueEnabled ??
    dependencies.telegramUpdateQueueEnabled ??
    Boolean(repositories?.jobs?.enqueue && repositories?.jobs?.claim);
  const telegramUpdateDispatcherIntervalMs =
    options.telegramUpdateDispatcherIntervalMs ??
    dependencies.telegramUpdateDispatcherIntervalMs ??
    1000;
  const telegramUpdateDispatcherMaxJobs =
    options.telegramUpdateDispatcherMaxJobs ??
    dependencies.telegramUpdateDispatcherMaxJobs ??
    10;
  const telegramUpdateDispatcherMaxAttempts =
    options.telegramUpdateDispatcherMaxAttempts ??
    dependencies.telegramUpdateDispatcherMaxAttempts ??
    3;
  const telegramUpdateDispatcherRetryDelayMs =
    options.telegramUpdateDispatcherRetryDelayMs ??
    dependencies.telegramUpdateDispatcherRetryDelayMs ??
    5000;
  const reminderDispatcherEnabled =
    options.reminderDispatcherEnabled ?? dependencies.reminderDispatcherEnabled ?? false;
  const reminderDispatcherIntervalMs =
    options.reminderDispatcherIntervalMs ??
    dependencies.reminderDispatcherIntervalMs ??
    30_000;
  const supervisorEnabled =
    options.supervisorEnabled ?? dependencies.supervisorEnabled ?? false;
  const supervisorIntervalMs =
    options.supervisorIntervalMs ?? dependencies.supervisorIntervalMs ?? 60_000;
  const supervisorAlertCooldownMs =
    options.supervisorAlertCooldownMs ??
    dependencies.supervisorAlertCooldownMs ??
    10 * 60_000;
  const supervisorAutoHeal =
    options.supervisorAutoHeal ?? dependencies.supervisorAutoHeal ?? true;
  const supervisorAlertChatId =
    options.supervisorAlertChatId ?? dependencies.supervisorAlertChatId;
  const supervisorAuditOkTicks =
    options.supervisorAuditOkTicks ?? dependencies.supervisorAuditOkTicks ?? false;
  const supervisorAuditDedupMs =
    options.supervisorAuditDedupMs ??
    dependencies.supervisorAuditDedupMs ??
    10 * 60_000;
  const users = options.users ?? dependencies.users ?? [];
  const orchestrator =
    options.orchestrator ??
    dependencies.orchestrator ??
    (repositories
      ? createRepositoryBackedOrchestrator({
          repositories,
          aiProvider: dependencies.aiProvider,
          capabilityRegistry: dependencies.capabilityRegistry,
          workspaceId: dependencies.workspaceId,
        })
      : ((request) => handleOrchestratorRequest(request, dependencies)));
  const telegramBackgroundUpdates = new Set();
  const telegramAcceptedAckTimestamps = new Map();
  let stopTelegramPolling;
  let telegramUpdateDispatcher;
  let supervisorLoop;
  let triggerTelegramUpdateDispatcher = () => {};

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, createHealthResponse());
        return;
      }

      if (request.method === "POST" && request.url === "/orchestrator/handle") {
        const body = await readJson(request);
        sendJson(response, 200, await orchestrator(body));
        return;
      }

      const telegramWebhookRoute =
        request.method === "POST" ? parseTelegramWebhookRoute(request.url) : null;

      if (telegramWebhookRoute) {
        const botKey = telegramWebhookRoute.botKey;
        const routeSecret = resolveTelegramWebhookSecret({
          botKey,
          telegramWebhookSecret,
          telegramWebhookSecrets,
        });
        const authorization = authorizeTelegramWebhookRequest({
          request,
          routeSecret,
          relayWebhookSecret: telegramRelayWebhookSecret,
          requireWebhookSecret: telegramRequireWebhookSecret,
          webhookIngressMode: telegramWebhookIngressMode,
        });
        if (!authorization.ok) {
          sendJson(response, authorization.statusCode, { error: authorization.error });
          return;
        }

        const body = await readJson(request);
        const routeReplyMode = telegramReplyMode;

        if (routeReplyMode === "webhook_response") {
          const rawText = telegramTextFromUpdate(body);
          const rawTelegramRequest = buildRawQueuedTelegramRequest(body, botKey);

          if (isTelegramConnectivityCheckText(rawText)) {
            sendJson(response, 200, buildConnectivityTelegramWebhookResponse(rawTelegramRequest));
            return;
          }

          if (
            telegramUpdateQueueEnabled &&
            !isTelegramStartCommandText(rawText) &&
            typeof repositories?.jobs?.enqueue === "function" &&
            telegramUpdateJobKey(body, botKey)
          ) {
            const backgroundSender = resolveTelegramBackgroundSender({
              botKey,
              telegramSender,
              telegramSenders,
              telegramBackgroundSender,
              telegramBackgroundSenders,
            });

            if (!backgroundSender) {
              sendJson(
                response,
                200,
                buildTelegramDeliveryNotConfiguredWebhookResponse(rawTelegramRequest),
              );
              return;
            }

            enqueueTelegramUpdateJobInBackground({
              repositories,
              update: body,
              botKey,
              triggerTelegramUpdateDispatcher,
            });

            sendJson(
              response,
              200,
              buildScheduledTelegramWebhookResponse(
                rawTelegramRequest,
                { queued: true },
                {
                  ackTimestamps: telegramAcceptedAckTimestamps,
                  ackThrottleMs: telegramAcceptedAckThrottleMs,
                },
              ),
            );
            return;
          }

          const telegramRequest = await buildTelegramWebhookRequest(body, {
            users,
            repositories,
            botKey,
            voiceTranscriber: resolveVoiceTranscriber({
              botKey,
              voiceTranscriber,
              voiceTranscribers,
            }),
            imageOcr: resolveImageOcr({
              botKey,
              imageOcr,
              imageOcrs,
            }),
            documentTextExtractor: resolveDocumentTextExtractor({
              botKey,
              documentTextExtractor,
              documentTextExtractors,
            }),
            deferMediaProcessing: true,
          });
          if (
            telegramRequest.rejected ||
            telegramRequest.voiceRejected ||
            telegramRequest.imageRejected ||
            telegramRequest.documentRejected ||
            telegramRequest.isStartCommand
          ) {
            sendJson(response, 200, buildImmediateTelegramWebhookResponse(telegramRequest));
            return;
          }

          const earlyBackgroundSender = resolveTelegramSender({
            botKey,
            telegramSender: telegramBackgroundSender,
            telegramSenders: telegramBackgroundSenders,
          });

          if (earlyBackgroundSender) {
            const scheduleResult = await scheduleTelegramBackgroundUpdate({
              body,
              users,
              repositories,
              orchestrator,
              telegramSender: earlyBackgroundSender,
              voiceTranscriber: resolveVoiceTranscriber({
                botKey,
                voiceTranscriber,
                voiceTranscribers,
              }),
              imageOcr: resolveImageOcr({
                botKey,
                imageOcr,
                imageOcrs,
              }),
              documentTextExtractor: resolveDocumentTextExtractor({
                botKey,
                documentTextExtractor,
                documentTextExtractors,
              }),
              botKey,
              telegramBackgroundDelayMs,
              telegramBackgroundUpdates,
              telegramUpdateQueueEnabled,
              triggerTelegramUpdateDispatcher,
            });
            sendJson(
              response,
              200,
              buildScheduledTelegramWebhookResponse(telegramRequest, scheduleResult, {
                ackTimestamps: telegramAcceptedAckTimestamps,
                ackThrottleMs: telegramAcceptedAckThrottleMs,
              }),
            );
            return;
          }

          if (
            repositories &&
            !telegramRequest.mediaDeferred &&
            isImmediateRepositoryBackedRequest(telegramRequest.text)
          ) {
            const backgroundSender = resolveTelegramBackgroundSender({
              botKey,
              telegramSender,
              telegramSenders,
              telegramBackgroundSender,
              telegramBackgroundSenders,
            });

            if (backgroundSender) {
              const scheduleResult = await scheduleTelegramBackgroundUpdate({
                body,
                users,
                repositories,
                orchestrator,
                telegramSender: backgroundSender,
                voiceTranscriber: resolveVoiceTranscriber({
                  botKey,
                  voiceTranscriber,
                  voiceTranscribers,
                }),
                imageOcr: resolveImageOcr({
                  botKey,
                  imageOcr,
                  imageOcrs,
                }),
                documentTextExtractor: resolveDocumentTextExtractor({
                  botKey,
                  documentTextExtractor,
                  documentTextExtractors,
                }),
                botKey,
                telegramBackgroundDelayMs,
                telegramBackgroundUpdates,
                telegramUpdateQueueEnabled,
                triggerTelegramUpdateDispatcher,
              });
              sendJson(
                response,
                200,
                buildScheduledTelegramWebhookResponse(telegramRequest, scheduleResult, {
                  ackTimestamps: telegramAcceptedAckTimestamps,
                  ackThrottleMs: telegramAcceptedAckThrottleMs,
                }),
              );
              return;
            }

            const result = await orchestrator(telegramRequest);
            sendJson(
              response,
              200,
              buildTelegramWebhookResponse(
                {
                  chatId: telegramRequest.chatId,
                  text: result.answer?.text ?? telegramAcceptedText,
                },
                "webhook_response",
              ),
            );
            return;
          }

          const backgroundSender = resolveTelegramBackgroundSender({
            botKey,
            telegramSender,
            telegramSenders,
            telegramBackgroundSender,
            telegramBackgroundSenders,
          });
          let scheduleResult = null;
          if (backgroundSender) {
            scheduleResult = await scheduleTelegramBackgroundUpdate({
              body,
              users,
              repositories,
              orchestrator,
              telegramSender: backgroundSender,
              voiceTranscriber: resolveVoiceTranscriber({
                botKey,
                voiceTranscriber,
                voiceTranscribers,
              }),
              imageOcr: resolveImageOcr({
                botKey,
                imageOcr,
                imageOcrs,
              }),
              documentTextExtractor: resolveDocumentTextExtractor({
                botKey,
                documentTextExtractor,
                documentTextExtractors,
              }),
              botKey,
              telegramBackgroundDelayMs,
              telegramBackgroundUpdates,
              telegramUpdateQueueEnabled,
              triggerTelegramUpdateDispatcher,
            });
          } else {
            sendJson(
              response,
              200,
              buildTelegramDeliveryNotConfiguredWebhookResponse(telegramRequest),
            );
            return;
          }

          sendJson(
            response,
            200,
            buildScheduledTelegramWebhookResponse(telegramRequest, scheduleResult, {
              ackTimestamps: telegramAcceptedAckTimestamps,
              ackThrottleMs: telegramAcceptedAckThrottleMs,
            }),
          );

          return;
        }

        const result = await handleTelegramUpdate(body, {
          users,
          repositories,
          orchestrator,
          telegramSender:
            routeReplyMode === "webhook_response"
              ? undefined
              : resolveTelegramSender({ botKey, telegramSender, telegramSenders }),
          voiceTranscriber: resolveVoiceTranscriber({
            botKey,
            voiceTranscriber,
            voiceTranscribers,
          }),
          imageOcr: resolveImageOcr({
            botKey,
            imageOcr,
            imageOcrs,
          }),
          documentTextExtractor: resolveDocumentTextExtractor({
            botKey,
            documentTextExtractor,
            documentTextExtractors,
          }),
          botKey,
        });
        sendJson(response, 200, buildTelegramWebhookResponse(result, routeReplyMode));
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, { error: "internal_error", message: error.message });
    }
  });

  if (reminderDispatcherEnabled) {
    let stopReminderDispatcher;
    server.on("listening", () => {
      stopReminderDispatcher = startReminderDispatcher({
        repositories,
        telegramSender: telegramBackgroundSender ?? telegramSender,
        telegramSenders: {
          ...telegramSenders,
          ...telegramBackgroundSenders,
        },
        intervalMs: reminderDispatcherIntervalMs,
      });
    });
    server.on("close", () => {
      stopReminderDispatcher?.();
    });
  }

  if (telegramUpdateQueueEnabled) {
    server.on("listening", () => {
      telegramUpdateDispatcher = startTelegramUpdateDispatcher({
        repositories,
        users,
        orchestrator,
        telegramSender,
        telegramSenders,
        telegramBackgroundSender,
        telegramBackgroundSenders,
        voiceTranscriber,
        voiceTranscribers,
        imageOcr,
        imageOcrs,
        documentTextExtractor,
        documentTextExtractors,
        intervalMs: telegramUpdateDispatcherIntervalMs,
        maxJobs: telegramUpdateDispatcherMaxJobs,
        maxAttempts: telegramUpdateDispatcherMaxAttempts,
        retryDelayMs: telegramUpdateDispatcherRetryDelayMs,
      });
      triggerTelegramUpdateDispatcher = () => telegramUpdateDispatcher?.trigger();
    });
    server.on("close", () => {
      telegramUpdateDispatcher?.stop();
    });
  }

  if (supervisorEnabled) {
    server.on("listening", () => {
      const supervisorSender = resolveTelegramBackgroundSender({
        botKey: "owner",
        telegramSender,
        telegramSenders,
        telegramBackgroundSender,
        telegramBackgroundSenders,
      });
      const notifier =
        supervisorAlertChatId && supervisorSender?.sendMessage
          ? (text) => supervisorSender.sendMessage({
              chatId: supervisorAlertChatId,
              text,
            })
          : undefined;

      supervisorLoop = startSupervisorLoop({
        repositories,
        notifier,
        autoHeal: supervisorAutoHeal,
        intervalMs: supervisorIntervalMs,
        alertCooldownMs: supervisorAlertCooldownMs,
        auditOkTicks: supervisorAuditOkTicks,
        auditDedupMs: supervisorAuditDedupMs,
      });
    });
    server.on("close", () => {
      supervisorLoop?.stop();
    });
  }

  if (telegramPollingEnabled) {
    server.on("listening", () => {
      const polling = startTelegramPolling({
        botTokens: telegramPollingBotTokens,
        fetchImpl: telegramPollingFetchImpl,
        intervalMs: telegramPollingIntervalMs,
        errorDelayMs: telegramPollingErrorDelayMs,
        timeoutSeconds: telegramPollingTimeoutSeconds,
        pollingStateRepository: telegramPollingStateRepository,
        clearWebhookBeforePolling: telegramPollingClearWebhookEnabled,
        handleUpdate: async (botKey, update) => {
          const pollingSender = resolveTelegramBackgroundSender({
            botKey,
            telegramSender,
            telegramSenders,
            telegramBackgroundSender,
            telegramBackgroundSenders,
          });
          if (!pollingSender?.sendMessage) {
            throw new Error("Telegram sender is not configured for polling update");
          }

          await scheduleTelegramBackgroundUpdate({
            body: update,
            users,
            repositories,
            orchestrator,
            telegramSender: pollingSender,
            voiceTranscriber: resolveVoiceTranscriber({
              botKey,
              voiceTranscriber,
              voiceTranscribers,
            }),
            imageOcr: resolveImageOcr({
              botKey,
              imageOcr,
              imageOcrs,
            }),
            documentTextExtractor: resolveDocumentTextExtractor({
              botKey,
              documentTextExtractor,
              documentTextExtractors,
            }),
            botKey,
            telegramBackgroundDelayMs,
            telegramBackgroundUpdates,
            telegramUpdateQueueEnabled,
            triggerTelegramUpdateDispatcher,
          });
        },
      });
      stopTelegramPolling = () => polling.stop();
    });
    server.on("close", () => {
      stopTelegramPolling?.();
    });
  }

  return server;
}

export function createAppServerFromEnv({
  env = process.env,
  repositories,
  prisma,
  fetchImpl = fetch,
} = {}) {
  return createAppServer({
    dependencies: createProductionDependencies({
      env,
      repositories,
      prisma,
      fetchImpl,
    }),
  });
}

export async function createAppServerFromEnvAsync({
  env = process.env,
  repositories,
  prisma,
  fetchImpl = fetch,
  importPrismaClient,
} = {}) {
  const resolvedPrisma =
    prisma ??
    (!repositories && envValue(env.DATABASE_URL)
      ? await createPrismaClient({ importClient: importPrismaClient })
      : undefined);

  if (resolvedPrisma) {
    await bootstrapUsersFromEnv({ prisma: resolvedPrisma, env });
  }

  return createAppServerFromEnv({
    env,
    repositories,
    prisma: resolvedPrisma,
    fetchImpl,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createAppServerFromEnvAsync()
    .then((server) => {
      server.listen(port, () => {
        console.log(`family-ai api listening on ${port}`);
      });
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
