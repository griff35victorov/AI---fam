import { createServer } from "node:http";

import { createHealthResponse } from "./health.js";
import { handleOrchestratorRequest } from "./orchestrator.js";
import { createProductionDependencies } from "./production-runtime.js";
import { createRepositoryBackedOrchestrator } from "./runtime.js";
import { handleTelegramUpdate } from "./telegram.js";

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function telegramWebhookSecretIsValid(request, secret) {
  if (!secret) {
    return true;
  }

  return request.headers["x-telegram-bot-api-secret-token"] === secret;
}

export function createAppServer(options = {}) {
  const dependencies = options.dependencies ?? {};
  const repositories = options.repositories ?? dependencies.repositories;
  const telegramSender = options.telegramSender ?? dependencies.telegramSender;
  const telegramWebhookSecret =
    options.telegramWebhookSecret ?? dependencies.telegramWebhookSecret;
  const users = options.users ?? dependencies.users ?? [];
  const orchestrator =
    options.orchestrator ??
    dependencies.orchestrator ??
    (repositories
      ? createRepositoryBackedOrchestrator({
          repositories,
          aiProvider: dependencies.aiProvider,
          workspaceId: dependencies.workspaceId,
        })
      : ((request) => handleOrchestratorRequest(request, dependencies)));

  return createServer(async (request, response) => {
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

      if (request.method === "POST" && request.url === "/telegram/webhook") {
        if (!telegramWebhookSecretIsValid(request, telegramWebhookSecret)) {
          sendJson(response, 401, { error: "telegram_webhook_secret_invalid" });
          return;
        }

        const body = await readJson(request);
        const result = await handleTelegramUpdate(body, {
          users,
          repositories,
          orchestrator,
          telegramSender,
        });
        sendJson(response, 200, { ok: true, ...result });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, { error: "internal_error", message: error.message });
    }
  });
}

export function createAppServerFromEnv({
  env = process.env,
  repositories,
  fetchImpl = fetch,
} = {}) {
  return createAppServer({
    dependencies: createProductionDependencies({
      env,
      repositories,
      fetchImpl,
    }),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createAppServerFromEnv().listen(port, () => {
    console.log(`family-ai api listening on ${port}`);
  });
}
