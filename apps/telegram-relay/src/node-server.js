import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { handleRelayRequest } from "./worker.js";

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function headersFromIncomingMessage(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  return headers;
}

async function webRequestFromIncomingMessage(request) {
  const host = request.headers.host ?? "127.0.0.1";
  const protocol = request.headers["x-forwarded-proto"] ?? "http";
  const url = new URL(request.url ?? "/", `${protocol}://${host}`);
  const method = request.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readRequestBody(request);

  return new Request(url, {
    method,
    headers: headersFromIncomingMessage(request),
    body,
  });
}

async function writeWebResponse(response, webResponse) {
  const headers = {};
  for (const [name, value] of webResponse.headers.entries()) {
    headers[name] = value;
  }

  const body = Buffer.from(await webResponse.arrayBuffer());
  headers["content-length"] = Buffer.byteLength(body);
  response.writeHead(webResponse.status, headers);
  response.end(body);
}

export function createRelayNodeServer({
  env = process.env,
  fetchImpl = fetch,
  ctx = {},
} = {}) {
  return createServer(async (request, response) => {
    try {
      const webRequest = await webRequestFromIncomingMessage(request);
      const webResponse = await handleRelayRequest(webRequest, env, ctx, { fetchImpl });
      await writeWebResponse(response, webResponse);
    } catch {
      await writeWebResponse(
        response,
        Response.json(
          { error: "internal_error" },
          {
            status: 500,
            headers: { "cache-control": "no-store" },
          },
        ),
      );
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  const server = createRelayNodeServer();
  server.listen(port, () => {
    console.log(`telegram relay listening on ${port}`);
  });
}
