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
import { startTelegramPolling } from "./telegram-poller.js";
import {
  accessNotConfiguredText,
  accessNotConfiguredTextForRequest,
  buildTelegramRequest,
  buildTelegramRequestFromRepositories,
  handleTelegramUpdate,
  startCommandText,
} from "./telegram.js";

const telegramAcceptedText = "Принял. Готовлю ответ отдельным сообщением.";
const urlPattern = /https?:\/\/\S+/i;

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
  if (update?.update_id == null) {
    return null;
  }

  return `${botKey ?? "default"}:${update.update_id}`;
}

function telegramChatIdFromUpdate(update) {
  const chatId = update?.message?.chat?.id;
  return chatId === undefined || chatId === null ? null : chatId;
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
  const telegramBackgroundDelayMs =
    options.telegramBackgroundDelayMs ?? dependencies.telegramBackgroundDelayMs ?? 0;
  const reminderDispatcherEnabled =
    options.reminderDispatcherEnabled ?? dependencies.reminderDispatcherEnabled ?? false;
  const reminderDispatcherIntervalMs =
    options.reminderDispatcherIntervalMs ??
    dependencies.reminderDispatcherIntervalMs ??
    30_000;
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
  let stopTelegramPolling;

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
        });
        if (!authorization.ok) {
          sendJson(response, authorization.statusCode, { error: authorization.error });
          return;
        }

        const body = await readJson(request);
        const routeReplyMode = telegramReplyMode;

        if (routeReplyMode === "webhook_response") {
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

          if (
            repositories &&
            !telegramRequest.mediaDeferred &&
            isImmediateRepositoryBackedRequest(telegramRequest.text)
          ) {
            const backgroundSender = resolveTelegramSender({
              botKey,
              telegramSender: telegramBackgroundSender,
              telegramSenders: telegramBackgroundSenders,
            });

            if (backgroundSender) {
              sendJson(response, 200, buildWebhookOkResponse());

              const backgroundKey = telegramBackgroundUpdateKey(body, botKey);
              if (!backgroundKey || !telegramBackgroundUpdates.has(backgroundKey)) {
                if (backgroundKey) {
                  telegramBackgroundUpdates.add(backgroundKey);
                }

                setTimeout(() => {
                  runTelegramBackgroundUpdate({
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
                    backgroundKey,
                    telegramBackgroundUpdates,
                  });
                }, telegramBackgroundDelayMs);
              }

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

          const backgroundSender = resolveTelegramSender({
            botKey,
            telegramSender: telegramBackgroundSender,
            telegramSenders: telegramBackgroundSenders,
          });
          sendJson(
            response,
            200,
            backgroundSender
              ? buildWebhookOkResponse()
              : buildImmediateTelegramWebhookResponse(telegramRequest),
          );

          const backgroundKey = telegramBackgroundUpdateKey(body, botKey);
          if (!backgroundKey || !telegramBackgroundUpdates.has(backgroundKey)) {
            if (backgroundKey) {
              telegramBackgroundUpdates.add(backgroundKey);
            }

            setTimeout(() => {
              runTelegramBackgroundUpdate({
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
                backgroundKey,
                telegramBackgroundUpdates,
              });
            }, telegramBackgroundDelayMs);
          }

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
        telegramSender,
        telegramSenders,
        intervalMs: reminderDispatcherIntervalMs,
      });
    });
    server.on("close", () => {
      stopReminderDispatcher?.();
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
        handleUpdate: async (botKey, update) => {
          const pollingSender = resolveTelegramSender({
            botKey,
            telegramSender: telegramBackgroundSender ?? telegramSender,
            telegramSenders:
              Object.keys(telegramBackgroundSenders).length > 0
                ? telegramBackgroundSenders
                : telegramSenders,
          });

          sendBackgroundChatAction({ telegramSender: pollingSender, body: update });

          await handleTelegramUpdate(update, {
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
