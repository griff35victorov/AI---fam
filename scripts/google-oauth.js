import http from "node:http";
import { fileURLToPath } from "node:url";

const defaultPort = 53682;
const scopes = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
];

function envValue(value) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function parsePort(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultPort;
}

function buildAuthUrl({ clientId, redirectUri }) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

function waitForAuthorizationCode({ port }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/oauth2callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(`Google authorization failed: ${error}`);
        server.close(() => reject(new Error(`Google authorization failed: ${error}`)));
        return;
      }

      if (!code) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Authorization code is missing.");
        server.close(() => reject(new Error("Authorization code is missing")));
        return;
      }

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<h1>Google connected</h1><p>You can return to the terminal.</p>");
      server.close(() => resolve(code));
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
}

async function exchangeCodeForToken({ clientId, clientSecret, code, redirectUri }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = payload.error_description ?? payload.error ?? response.status;
    throw new Error(`Google token exchange failed: ${detail}`);
  }

  if (!payload.refresh_token) {
    throw new Error("Google did not return refresh_token. Revoke app access and run again with prompt=consent.");
  }

  return payload;
}

export async function runGoogleOAuthCli({
  env = process.env,
  stdout = process.stdout,
} = {}) {
  const clientId = envValue(env.GOOGLE_CLIENT_ID);
  const clientSecret = envValue(env.GOOGLE_CLIENT_SECRET);
  if (!clientId || !clientSecret) {
    throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before running this script.");
  }

  const port = parsePort(env.GOOGLE_OAUTH_LOCAL_PORT);
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const authUrl = buildAuthUrl({ clientId, redirectUri });
  const waitingForCode = waitForAuthorizationCode({ port });

  stdout.write("Open this URL and grant read-only access to Gmail and Calendar:\n\n");
  stdout.write(`${authUrl}\n\n`);
  stdout.write(`Waiting on ${redirectUri}\n\n`);

  const code = await waitingForCode;
  const token = await exchangeCodeForToken({
    clientId,
    clientSecret,
    code,
    redirectUri,
  });

  stdout.write("Add these values to Timeweb App Platform environment variables:\n\n");
  stdout.write(`GOOGLE_CLIENT_ID=${clientId}\n`);
  stdout.write(`GOOGLE_CLIENT_SECRET=${clientSecret}\n`);
  stdout.write(`GOOGLE_REFRESH_TOKEN=${token.refresh_token}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGoogleOAuthCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
