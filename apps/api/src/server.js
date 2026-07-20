import { createServer } from "node:http";

import { createHealthResponse } from "./health.js";
import { handleOrchestratorRequest } from "./orchestrator.js";
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

export function createAppServer(options = {}) {
  const dependencies = options.dependencies ?? {};
  const users = options.users ?? dependencies.users ?? [];
  const orchestrator =
    options.orchestrator ??
    dependencies.orchestrator ??
    ((request) => handleOrchestratorRequest(request, dependencies));

  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, createHealthResponse());
        return;
      }

      if (request.method === "POST" && request.url === "/orchestrator/handle") {
        const body = await readJson(request);
        sendJson(response, 200, await handleOrchestratorRequest(body));
        return;
      }

      if (request.method === "POST" && request.url === "/telegram/webhook") {
        const body = await readJson(request);
        const result = await handleTelegramUpdate(body, { users, orchestrator });
        sendJson(response, 200, { ok: true, ...result });
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 500, { error: "internal_error", message: error.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createAppServer().listen(port, () => {
    console.log(`family-ai api listening on ${port}`);
  });
}
