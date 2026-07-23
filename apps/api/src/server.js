import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

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
  inferIntentFromText,
  startCommandText,
  telegramUpdateDedupeKeyPart,
} from "./telegram.js";

const telegramAcceptedText = "Принял. Готовлю ответ отдельным сообщением.";
const telegramConnectivityText =
  "Связь установлена. Telegram gateway, App Platform и оркестр отвечают. Если запрос требует AI или инструмента, финальный ответ придет отдельным сообщением.";
const urlPattern = /https?:\/\/\S+/i;
const defaultTelegramAcceptedAckThrottleMs = 8000;
const defaultWebChatMaxAttachmentBytes = 8 * 1024 * 1024;
const defaultWebChatMaxExtractedChars = 16_000;
const webChatTextAttachmentMimeTypes = new Set([
  "application/json",
  "application/x-ndjson",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
]);

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "connection": "close",
  });
  response.end(payload);
}

function sendHtml(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "connection": "close",
  });
  response.end(body);
}

function sendBinary(
  response,
  statusCode,
  body,
  contentType,
  cacheControl = "public, max-age=31536000, immutable",
) {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    "connection": "close",
  });
  response.end(body);
}

const familyAssetRoot = join(process.cwd(), "apps", "api", "public", "assets", "family");
const familyAssetContentTypes = new Map([
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const familyAssetFiles = new Set([
  "daughter.jpg",
  "family-ski.jpg",
  "teacher-forest.jpg",
  "teacher-home.jpg",
]);

function familyAssetFromPathname(pathname) {
  const prefix = "/assets/family/";
  if (!pathname.startsWith(prefix)) return null;

  let fileName;
  try {
    fileName = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  if (!familyAssetFiles.has(fileName)) return null;

  return {
    path: join(familyAssetRoot, fileName),
    contentType:
      familyAssetContentTypes.get(extname(fileName).toLowerCase()) ??
      "application/octet-stream",
  };
}

async function readRequestBuffer(request, { maxBytes } = {}) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (maxBytes && totalBytes > maxBytes) {
      const error = new Error("request_body_too_large");
      error.code = "request_body_too_large";
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJson(request) {
  const buffer = await readRequestBuffer(request);
  if (buffer.length === 0) return {};
  return JSON.parse(buffer.toString("utf8"));
}

function accessCodeMatches(received, expected) {
  if (!expected || typeof received !== "string") {
    return false;
  }

  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

const webChatRoleMap = {
  owner: "owner",
  daughter: "family_child",
  teacher: "teacher",
};

function normalizeWebChatRole(role) {
  return webChatRoleMap[String(role ?? "").trim().toLowerCase()] ?? null;
}

async function resolveWebChatActor({ role, repositories, users = [] }) {
  const dbRole = normalizeWebChatRole(role);
  if (!dbRole) {
    return null;
  }

  if (typeof repositories?.users?.findFirstByRole === "function") {
    return repositories.users.findFirstByRole(dbRole);
  }

  return users.find((user) => user.role === dbRole) ?? null;
}

function buildWebChatRequest({ body, actor, workspaceId }) {
  const text = String(body.message ?? body.text ?? "").trim();
  const role = String(body.role ?? "").trim().toLowerCase();
  return {
    actor,
    intent: inferIntentFromText(actor, text),
    text,
    conversationId: `web:${role}:${actor.id}`,
    workspaceId: actor.workspaceId ?? workspaceId,
    source: "web_chat",
  };
}

function httpRequestError(error, statusCode) {
  const requestError = new Error(error);
  requestError.code = error;
  requestError.statusCode = statusCode;
  return requestError;
}

function requestContentType(request) {
  return String(request.headers["content-type"] ?? "");
}

function isMultipartFormDataRequest(request) {
  return /^multipart\/form-data\b/i.test(requestContentType(request));
}

function multipartBoundaryFromContentType(contentType) {
  const match = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  return match?.[1] ?? match?.[2] ?? null;
}

function parseMultipartHeaders(headerText) {
  const headers = {};
  for (const line of headerText.split("\r\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const name = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

function multipartDispositionValue(disposition, key) {
  const match = disposition.match(new RegExp(`${key}="([^"]*)"`, "i"));
  return match?.[1] ?? null;
}

function normalizeUploadedFileName(fileName) {
  return (
    String(fileName ?? "attachment")
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/[\u0000-\u001f\u007f]/g, "")
      .trim() || "attachment"
  );
}

function parseMultipartFormDataBody({ contentType, buffer }) {
  const boundary = multipartBoundaryFromContentType(contentType);
  if (!boundary) {
    throw httpRequestError("multipart_boundary_missing", 400);
  }

  const delimiter = `--${boundary}`;
  const rawParts = buffer.toString("latin1").split(delimiter);
  const fields = {};
  const files = [];

  for (const rawPart of rawParts.slice(1)) {
    if (rawPart.startsWith("--")) break;

    let part = rawPart;
    if (part.startsWith("\r\n")) part = part.slice(2);
    if (part.endsWith("\r\n")) part = part.slice(0, -2);
    if (!part) continue;

    const headerEndIndex = part.indexOf("\r\n\r\n");
    if (headerEndIndex === -1) continue;

    const headers = parseMultipartHeaders(part.slice(0, headerEndIndex));
    const disposition = headers["content-disposition"] ?? "";
    const fieldName = multipartDispositionValue(disposition, "name");
    if (!fieldName) continue;

    const fileName = multipartDispositionValue(disposition, "filename");
    const content = Buffer.from(part.slice(headerEndIndex + 4), "latin1");
    if (fileName != null && fileName !== "") {
      files.push({
        fieldName,
        fileName: normalizeUploadedFileName(fileName),
        contentType: headers["content-type"] ?? "application/octet-stream",
        buffer: content,
      });
      continue;
    }

    fields[fieldName] = content.toString("utf8").replace(/\u0000/g, "").trim();
  }

  return { body: fields, attachments: files };
}

async function readWebChatBody(request, { maxAttachmentBytes }) {
  if (!isMultipartFormDataRequest(request)) {
    return { body: await readJson(request), attachments: [] };
  }

  const buffer = await readRequestBuffer(request, {
    maxBytes: maxAttachmentBytes + 64 * 1024,
  });
  return parseMultipartFormDataBody({
    contentType: requestContentType(request),
    buffer,
  });
}

function webChatAttachmentExtension(fileName) {
  return extname(String(fileName ?? "")).toLowerCase();
}

function isSupportedWebChatTextAttachment({ fileName, contentType }) {
  const normalizedMimeType = String(contentType ?? "").toLowerCase();
  if (normalizedMimeType.startsWith("text/")) return true;
  if (webChatTextAttachmentMimeTypes.has(normalizedMimeType)) return true;
  return /\.(?:csv|json|md|markdown|txt)$/i.test(String(fileName ?? ""));
}

function isSupportedWebChatImageAttachment({ fileName, contentType }) {
  const normalizedMimeType = String(contentType ?? "").toLowerCase();
  if (normalizedMimeType.startsWith("image/")) return true;
  return /\.(?:gif|jpe?g|png|webp)$/i.test(String(fileName ?? ""));
}

function safeImageExtension({ fileName, contentType }) {
  const extension = webChatAttachmentExtension(fileName);
  if ([".gif", ".jpg", ".jpeg", ".png", ".webp"].includes(extension)) {
    return extension;
  }

  const normalizedMimeType = String(contentType ?? "").toLowerCase();
  if (normalizedMimeType.includes("png")) return ".png";
  if (normalizedMimeType.includes("webp")) return ".webp";
  if (normalizedMimeType.includes("gif")) return ".gif";
  return ".jpg";
}

function truncateExtractedWebChatText(text, maxChars) {
  const normalizedText = String(text ?? "").replace(/\u0000/g, "").trim();
  if (normalizedText.length <= maxChars) return normalizedText;
  return `${normalizedText.slice(0, maxChars).trim()}\n\n[Текст вложения сокращен до ${maxChars} символов]`;
}

function formatExtractedWebChatAttachment({ file, heading, text, maxExtractedChars }) {
  return [
    `[${heading}: ${file.fileName}]`,
    `Тип: ${file.contentType}`,
    truncateExtractedWebChatText(text, maxExtractedChars),
  ]
    .filter(Boolean)
    .join("\n");
}

async function recognizeWebChatImageAttachment({ file, imageOcr, maxExtractedChars }) {
  if (typeof imageOcr?.recognizeFile !== "function") {
    return {
      ok: false,
      statusCode: 503,
      error: "web_chat_image_ocr_not_configured",
    };
  }

  const tempDirectory = join(tmpdir(), "family-ai-web-chat-ocr");
  await mkdir(tempDirectory, { recursive: true });
  const imagePath = join(
    tempDirectory,
    `${Date.now()}-${randomUUID()}${safeImageExtension(file)}`,
  );

  try {
    await writeFile(imagePath, file.buffer);
    const recognizedText = await imageOcr.recognizeFile(imagePath);
    const text = truncateExtractedWebChatText(recognizedText, maxExtractedChars);
    if (!text) {
      return {
        ok: false,
        statusCode: 422,
        error: "web_chat_image_ocr_empty",
      };
    }

    return {
      ok: true,
      text: formatExtractedWebChatAttachment({
        file,
        heading: "Изображение",
        text: `Распознанный текст:\n${text}`,
        maxExtractedChars,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 422,
      error: "web_chat_image_ocr_failed",
      message: error.message,
    };
  } finally {
    await rm(imagePath, { force: true }).catch(() => {});
  }
}

async function extractWebChatAttachmentText({
  file,
  imageOcr,
  maxAttachmentBytes,
  maxExtractedChars,
}) {
  if (!file?.buffer?.length) {
    return { ok: false, statusCode: 400, error: "web_chat_attachment_empty" };
  }

  if (file.buffer.length > maxAttachmentBytes) {
    return { ok: false, statusCode: 413, error: "web_chat_attachment_too_large" };
  }

  if (isSupportedWebChatTextAttachment(file)) {
    return {
      ok: true,
      text: formatExtractedWebChatAttachment({
        file,
        heading: "Файл",
        text: file.buffer.toString("utf8").replace(/\u0000/g, "").trim(),
        maxExtractedChars,
      }),
    };
  }

  if (isSupportedWebChatImageAttachment(file)) {
    return recognizeWebChatImageAttachment({
      file,
      imageOcr,
      maxExtractedChars,
    });
  }

  return { ok: false, statusCode: 415, error: "web_chat_attachment_unsupported" };
}

async function bodyWithWebChatAttachments({
  body,
  attachments,
  imageOcr,
  maxAttachmentBytes,
  maxExtractedChars,
}) {
  if (!attachments.length) return body;

  const extractedTexts = [];
  for (const file of attachments) {
    const extracted = await extractWebChatAttachmentText({
      file,
      imageOcr,
      maxAttachmentBytes,
      maxExtractedChars,
    });
    if (!extracted.ok) return extracted;
    extractedTexts.push(extracted.text);
  }

  const originalText = String(body.message ?? body.text ?? "").trim();
  const message = [originalText, ...extractedTexts].filter(Boolean).join("\n\n");

  return {
    ...body,
    message,
    text: message,
  };
}

const webChatPage = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Семейный AI - чат</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #fff7e7;
      --surface: #ffffff;
      --ink: #182016;
      --muted: #64705f;
      --line: #eadcba;
      --accent: #f05d7f;
      --accent-strong: #b92f54;
      --shadow: 0 30px 80px rgba(75, 54, 23, .16);
      --ease: cubic-bezier(.2, .8, .2, 1);
      font-family: "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    * { box-sizing: border-box; }
    html { min-height: 100%; }
    body {
      margin: 0;
      min-height: 100dvh;
      background:
        linear-gradient(135deg, rgba(255, 247, 231, .96), rgba(232, 252, 238, .92)),
        repeating-linear-gradient(45deg, rgba(240, 93, 127, .08) 0 2px, transparent 2px 18px);
      color: var(--ink);
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(rgba(24, 32, 22, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(24, 32, 22, .035) 1px, transparent 1px);
      background-size: 38px 38px;
      mask-image: linear-gradient(to bottom, rgba(0, 0, 0, .55), transparent 75%);
    }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; }
    .app-shell {
      width: min(1440px, 100%);
      min-height: 100dvh;
      margin: 0 auto;
      padding: 18px;
      display: grid;
      grid-template-columns: minmax(260px, 330px) minmax(0, 1fr);
      gap: 18px;
    }
    .family-panel, .chat-panel {
      position: relative;
      border: 1px solid rgba(88, 105, 91, .18);
      border-radius: 26px;
      background: rgba(255, 255, 255, .88);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .family-panel {
      min-height: calc(100dvh - 36px);
      padding: 10px;
    }
    .family-card {
      min-height: 100%;
      border: 1px solid rgba(255, 255, 255, .85);
      border-radius: 20px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, .96), rgba(255, 241, 204, .9)),
        repeating-linear-gradient(-8deg, transparent 0 18px, rgba(100, 201, 149, .08) 18px 21px);
      padding: 16px;
      display: grid;
      align-content: start;
      gap: 12px;
    }
    .brand-lockup { display: grid; gap: 6px; }
    .eyebrow {
      margin: 0;
      color: #1c6f49;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .11em;
    }
    h1, h2, p { margin: 0; }
    h1 {
      color: var(--ink);
      font-size: clamp(30px, 4.2vw, 46px);
      line-height: .95;
      letter-spacing: 0;
      max-width: 9ch;
    }
    .family-gallery {
      display: grid;
      gap: 12px;
    }
    .lead-photo {
      margin: 0;
      aspect-ratio: 479 / 671;
      border-radius: 24px;
      background: #dfe7dd;
      overflow: hidden;
      position: relative;
      border: 7px solid #ffffff;
      transform: rotate(-1.4deg);
      box-shadow: 0 20px 42px rgba(75, 54, 23, .18);
    }
    .lead-photo img, .family-avatar img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
      filter: saturate(1.08) contrast(1.03);
    }
    .lead-photo figcaption {
      position: absolute;
      left: 10px;
      bottom: 10px;
      max-width: calc(100% - 20px);
      border-radius: 14px;
      background: #ffcf5a;
      color: var(--ink);
      padding: 8px 11px;
      font-size: 12px;
      font-weight: 800;
      box-shadow: 0 8px 20px rgba(75, 54, 23, .16);
    }
    .avatar-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 9px;
    }
    .family-avatar {
      margin: 0;
      aspect-ratio: 1;
      border-radius: 20px;
      background: #edf1ea;
      overflow: hidden;
      border: 5px solid #ffffff;
      box-shadow: 0 11px 24px rgba(75, 54, 23, .13);
    }
    .family-avatar:nth-child(1) { transform: rotate(1.8deg); }
    .family-avatar:nth-child(2) { transform: rotate(-1.2deg); }
    .family-avatar:nth-child(3) { transform: rotate(1.1deg); }
    .chat-panel {
      min-height: calc(100dvh - 36px);
      padding: 10px;
      display: grid;
    }
    .chat-core {
      min-height: 100%;
      border: 1px solid rgba(255, 255, 255, .88);
      border-radius: 20px;
      background: rgba(255, 253, 247, .94);
      display: grid;
      grid-template-rows: auto minmax(280px, 1fr) auto;
      overflow: hidden;
    }
    .chat-top {
      display: grid;
      grid-template-columns: minmax(210px, 1fr) minmax(280px, 520px);
      gap: 14px;
      align-items: end;
      padding: 16px;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(90deg, rgba(255, 207, 90, .26), rgba(255, 255, 255, .72)),
        rgba(255, 255, 255, .82);
    }
    .chat-title { display: grid; gap: 5px; }
    h2 {
      font-size: clamp(22px, 3vw, 32px);
      line-height: 1.05;
      letter-spacing: 0;
    }
    .settings {
      display: grid;
      grid-template-columns: minmax(170px, 1fr) minmax(150px, 190px);
      gap: 10px;
    }
    label {
      display: grid;
      gap: 6px;
      color: #2d3e34;
      font-size: 12px;
      font-weight: 780;
    }
    input, select, textarea {
      min-width: 0;
      width: 100%;
      border: 1px solid rgba(88, 105, 91, .25);
      border-radius: 18px;
      background: rgba(255, 255, 255, .94);
      color: var(--ink);
      padding: 12px 13px;
      transition: border-color 240ms var(--ease), box-shadow 240ms var(--ease), background 240ms var(--ease);
    }
    input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible {
      outline: 3px solid rgba(185, 67, 95, .22);
      outline-offset: 2px;
      border-color: var(--accent);
      box-shadow: 0 0 0 4px rgba(185, 67, 95, .12);
    }
    textarea {
      min-height: 84px;
      max-height: 180px;
      resize: vertical;
      line-height: 1.45;
    }
    #messages {
      display: grid;
      align-content: start;
      gap: 12px;
      overflow: auto;
      padding: 18px;
      scroll-behavior: smooth;
      background:
        linear-gradient(rgba(255, 253, 247, .94), rgba(255, 253, 247, .94)),
        repeating-linear-gradient(-35deg, rgba(255, 181, 71, .12) 0 3px, transparent 3px 24px);
    }
    .message {
      width: min(76%, 68ch);
      border: 1px solid rgba(88, 105, 91, .16);
      border-radius: 20px;
      background: var(--surface);
      color: var(--ink);
      padding: 11px 13px 12px;
      display: grid;
      gap: 5px;
      white-space: pre-wrap;
      line-height: 1.45;
      box-shadow: 0 12px 24px rgba(75, 54, 23, .08);
      animation: message-in 420ms var(--ease) both;
    }
    .message.user {
      justify-self: end;
      border-color: rgba(185, 67, 95, .22);
      background: #ffe6ef;
    }
    .message.assistant { justify-self: start; }
    .message.error {
      justify-self: start;
      border-color: rgba(185, 67, 67, .28);
      background: #fff1f1;
      color: #7f1d1d;
    }
    .message-role {
      color: var(--muted);
      font-size: 11px;
      font-weight: 820;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .message-text { overflow-wrap: anywhere; }
    .message.pending .message-text::after {
      content: "";
      display: inline-block;
      width: 22px;
      height: 8px;
      margin-left: 8px;
      border-radius: 999px;
      background: linear-gradient(90deg, rgba(185, 67, 95, .25), rgba(185, 67, 95, .75), rgba(185, 67, 95, .25));
      animation: pulse 1s var(--ease) infinite;
    }
    .composer {
      padding: 14px 16px 16px;
      border-top: 1px solid var(--line);
      background: rgba(255, 255, 255, .84);
      display: grid;
      gap: 10px;
    }
    .composer-bar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: end;
    }
    .composer-actions {
      display: grid;
      grid-template-columns: auto auto;
      gap: 8px;
      align-items: center;
    }
    .attach-button {
      min-height: 48px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(88, 105, 91, .24);
      border-radius: 18px;
      background: #ffffff;
      color: var(--ink);
      padding: 0 14px;
      font-size: 13px;
      font-weight: 800;
      transition: transform 260ms var(--ease), border-color 260ms var(--ease), background 260ms var(--ease);
    }
    .attach-button:hover { transform: translateY(-1px); border-color: rgba(185, 67, 95, .32); background: #fff8fa; }
    .attach-button input {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }
    #send {
      min-height: 48px;
      min-width: 132px;
      border: 1px solid var(--accent-strong);
      border-radius: 18px;
      background: var(--accent);
      color: #ffffff;
      padding: 0 18px;
      font-weight: 850;
      box-shadow: 0 12px 24px rgba(185, 67, 95, .25);
      transition: transform 260ms var(--ease), box-shadow 260ms var(--ease), background 260ms var(--ease);
    }
    #send:hover:not(:disabled) { transform: translateY(-1px); background: var(--accent-strong); box-shadow: 0 16px 30px rgba(185, 67, 95, .28); }
    #send:active:not(:disabled) { transform: translateY(1px) scale(.99); }
    #send:disabled {
      cursor: wait;
      background: #8e8f8a;
      border-color: #7c7d78;
      box-shadow: none;
    }
    .file-meta {
      min-height: 18px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    @keyframes message-in {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0%, 100% { opacity: .38; transform: translateY(0); }
      50% { opacity: 1; transform: translateY(-1px); }
    }
    @media (max-width: 980px) {
      .app-shell {
        min-height: auto;
        grid-template-columns: 1fr;
        padding: 10px;
      }
      .family-panel, .chat-panel { min-height: auto; }
      .family-card {
        grid-template-columns: minmax(0, 1.2fr) minmax(220px, .8fr);
        align-items: start;
      }
      .brand-lockup { grid-column: 1; }
      .family-gallery { grid-column: 2; grid-row: 1 / span 2; }
      .lead-photo { aspect-ratio: 4 / 3; }
      h1 { max-width: 11ch; }
    }
    @media (max-width: 760px) {
      .app-shell { padding: 8px; gap: 8px; }
      .family-panel, .chat-panel { border-radius: 18px; }
      .family-card {
        grid-template-columns: 1fr;
        padding: 12px;
        gap: 12px;
      }
      .family-gallery { grid-column: auto; grid-row: auto; }
      .lead-photo { aspect-ratio: 16 / 9; }
      h1 { font-size: 32px; max-width: none; }
      .chat-core { min-height: calc(100dvh - 18px); grid-template-rows: auto minmax(46dvh, 1fr) auto; }
      .chat-top { grid-template-columns: 1fr; padding: 12px; }
      .settings { grid-template-columns: 1fr; }
      #messages { padding: 12px; }
      .message { width: min(96%, 68ch); }
      .composer { padding: 12px; }
      .composer-bar { grid-template-columns: 1fr; }
      .composer-actions { grid-template-columns: 1fr 1fr; }
      #send, .attach-button { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 1ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: 1ms !important;
      }
    }
  </style>
</head>
<body>
  <main class="app-shell">
    <aside class="family-panel" aria-label="Семейный контекст">
      <section class="family-card">
        <div class="brand-lockup">
          <p class="eyebrow">Family AI</p>
          <h1>Семейный чат</h1>
        </div>
        <div class="family-gallery" aria-label="Семейная галерея">
          <figure class="lead-photo">
            <img src="/assets/family/family-ski.jpg" width="479" height="671" alt="Семья на зимнем отдыхе" loading="eager">
            <figcaption>Команда на старте</figcaption>
          </figure>
          <div class="avatar-grid">
            <figure class="family-avatar"><img src="/assets/family/daughter.jpg" width="640" height="640" alt="Профиль Милы" loading="lazy"></figure>
            <figure class="family-avatar"><img src="/assets/family/teacher-forest.jpg" width="640" height="640" alt="Профиль учителя английского" loading="lazy"></figure>
            <figure class="family-avatar"><img src="/assets/family/teacher-home.jpg" width="640" height="640" alt="Профиль семейного преподавателя" loading="lazy"></figure>
          </div>
        </div>
      </section>
    </aside>
    <section class="chat-panel" aria-label="Чат с семейным AI">
      <div class="chat-core">
        <header class="chat-top">
          <div class="chat-title">
            <h2>Чат</h2>
          </div>
          <div class="settings">
            <label for="code">Код доступа<input id="code" name="code" type="password" autocomplete="current-password" required></label>
            <label for="role">Профиль<select id="role" name="role">
              <option value="owner">Григорий</option>
              <option value="daughter">Мила</option>
              <option value="teacher">English Teacher AI</option>
            </select></label>
          </div>
        </header>
        <div id="messages" aria-live="polite">
          <div class="message assistant">
            <span class="message-role">Family AI</span>
            <span class="message-text">Я на связи.</span>
          </div>
        </div>
        <form id="chat-form" class="composer">
          <label for="message">Сообщение</label>
          <div class="composer-bar">
            <textarea id="message" name="message" placeholder="Напишите задачу или вопрос"></textarea>
            <div class="composer-actions">
              <label class="attach-button" for="attachment">Файл<input id="attachment" name="attachment" type="file" accept=".txt,.md,.markdown,.csv,.json,image/*"></label>
              <button id="send" type="submit">Отправить</button>
            </div>
          </div>
          <div id="file-name" class="file-meta">Файл не выбран</div>
        </form>
      </div>
    </section>
  </main>
  <script>
    const form = document.getElementById("chat-form");
    const messages = document.getElementById("messages");
    const send = document.getElementById("send");
    const role = document.getElementById("role");
    const attachment = document.getElementById("attachment");
    const fileName = document.getElementById("file-name");
    const savedRole = sessionStorage.getItem("family-ai-role");
    if (savedRole) role.value = savedRole;

    function setFileName() {
      const file = attachment.files && attachment.files.length > 0 ? attachment.files[0] : null;
      fileName.textContent = file ? "Выбран файл: " + file.name : "Файл не выбран";
    }

    function appendMessage(kind, text) {
      const item = document.createElement("div");
      item.className = "message " + kind;

      const label = document.createElement("span");
      label.className = "message-role";
      label.textContent = kind.includes("user") ? "Вы" : "Family AI";

      const content = document.createElement("span");
      content.className = "message-text";
      content.textContent = text;

      item.append(label, content);
      messages.appendChild(item);
      messages.scrollTop = messages.scrollHeight;
      return item;
    }

    attachment.addEventListener("change", setFileName);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = document.getElementById("message");
      const code = document.getElementById("code");
      const text = message.value.trim();
      const file = attachment.files && attachment.files.length > 0 ? attachment.files[0] : null;
      if (!text && !file) return;

      sessionStorage.setItem("family-ai-role", role.value);
      appendMessage("user", file ? [text || "Вложение без текста", "Файл: " + file.name].join("\\n") : text);
      message.value = "";
      const pending = appendMessage("assistant pending", "Готовлю ответ...");
      send.disabled = true;

      try {
        let response;
        if (file) {
          const formData = new FormData();
          formData.set("accessCode", code.value);
          formData.set("role", role.value);
          formData.set("message", text);
          formData.set("attachment", file);
          response = await fetch("/web/chat", {
            method: "POST",
            body: formData,
          });
        } else {
          response = await fetch("/web/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              accessCode: code.value,
              role: role.value,
              message: text,
            }),
          });
        }
        const body = await response.json();
        pending.className = response.ok ? "message assistant" : "message error";
        pending.querySelector(".message-role").textContent = response.ok ? "Family AI" : "Ошибка";
        pending.querySelector(".message-text").textContent = response.ok
          ? (body.answer && body.answer.text ? body.answer.text : "Пустой ответ")
          : ("Ошибка: " + (body.error || "request_failed"));
        if (response.ok) {
          attachment.value = "";
          setFileName();
        }
      } catch (error) {
        pending.className = "message error";
        pending.querySelector(".message-role").textContent = "Ошибка";
        pending.querySelector(".message-text").textContent = "Ошибка связи с backend.";
      } finally {
        send.disabled = false;
        message.focus();
      }
    });
  </script>
</body>
</html>`;

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
  const supervisorHealFailedTelegramUpdates =
    options.supervisorHealFailedTelegramUpdates ??
    dependencies.supervisorHealFailedTelegramUpdates ??
    true;
  const supervisorAlertChatId =
    options.supervisorAlertChatId ?? dependencies.supervisorAlertChatId;
  const supervisorAuditOkTicks =
    options.supervisorAuditOkTicks ?? dependencies.supervisorAuditOkTicks ?? false;
  const supervisorAuditDedupMs =
    options.supervisorAuditDedupMs ??
    dependencies.supervisorAuditDedupMs ??
    10 * 60_000;
  const webChatAccessCode =
    options.webChatAccessCode ?? dependencies.webChatAccessCode;
  const webChatUrl =
    options.webChatUrl ?? dependencies.webChatUrl ?? "/chat";
  const webChatMaxAttachmentBytes =
    Number(options.webChatMaxAttachmentBytes ?? dependencies.webChatMaxAttachmentBytes) ||
    defaultWebChatMaxAttachmentBytes;
  const webChatMaxExtractedChars =
    Number(options.webChatMaxExtractedChars ?? dependencies.webChatMaxExtractedChars) ||
    defaultWebChatMaxExtractedChars;
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
          webChatAccessCode,
          webChatUrl,
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
      const requestPathname = new URL(request.url ?? "/", "http://localhost").pathname;

      if (request.method === "GET" && requestPathname === "/health") {
        sendJson(response, 200, createHealthResponse());
        return;
      }

      const familyAsset = familyAssetFromPathname(requestPathname);
      if (request.method === "GET" && familyAsset) {
        try {
          sendBinary(response, 200, await readFile(familyAsset.path), familyAsset.contentType);
        } catch {
          sendJson(response, 404, { error: "asset_not_found" });
        }
        return;
      }

      if (
        request.method === "GET" &&
        (requestPathname === "/" || requestPathname === "/chat")
      ) {
        sendHtml(response, 200, webChatPage);
        return;
      }

      if (request.method === "POST" && requestPathname === "/orchestrator/handle") {
        const body = await readJson(request);
        sendJson(response, 200, await orchestrator(body));
        return;
      }

      if (request.method === "POST" && requestPathname === "/web/chat") {
        if (!webChatAccessCode) {
          sendJson(response, 503, { error: "web_chat_access_code_not_configured" });
          return;
        }

        let parsedWebChatBody;
        try {
          parsedWebChatBody = await readWebChatBody(request, {
            maxAttachmentBytes: webChatMaxAttachmentBytes,
          });
        } catch (error) {
          if (error.code === "request_body_too_large") {
            sendJson(response, 413, { error: "web_chat_attachment_too_large" });
            return;
          }
          if (error.statusCode) {
            sendJson(response, error.statusCode, { error: error.code });
            return;
          }
          if (error instanceof SyntaxError) {
            sendJson(response, 400, { error: "web_chat_body_invalid" });
            return;
          }
          throw error;
        }

        const { attachments } = parsedWebChatBody;
        let body = parsedWebChatBody.body;
        const receivedAccessCode =
          body.accessCode ?? body.code ?? request.headers["x-family-ai-web-code"];
        if (!accessCodeMatches(receivedAccessCode, webChatAccessCode)) {
          sendJson(response, 401, { error: "web_chat_access_code_invalid" });
          return;
        }

        const actor = await resolveWebChatActor({
          role: body.role,
          repositories,
          users,
        });
        if (!actor) {
          sendJson(response, 403, { error: "web_chat_role_not_allowed" });
          return;
        }

        const bodyWithAttachments = await bodyWithWebChatAttachments({
          body,
          attachments,
          imageOcr: resolveImageOcr({
            botKey: String(body.role ?? "").trim().toLowerCase(),
            imageOcr,
            imageOcrs,
          }),
          maxAttachmentBytes: webChatMaxAttachmentBytes,
          maxExtractedChars: webChatMaxExtractedChars,
        });
        if (bodyWithAttachments.ok === false) {
          sendJson(response, bodyWithAttachments.statusCode, {
            error: bodyWithAttachments.error,
            message: bodyWithAttachments.message,
          });
          return;
        }
        body = bodyWithAttachments;

        const text = String(body.message ?? body.text ?? "").trim();
        if (!text) {
          sendJson(response, 400, { error: "message_required" });
          return;
        }

        const result = await orchestrator(
          buildWebChatRequest({
            body,
            actor,
            workspaceId: dependencies.workspaceId,
          }),
        );
        sendJson(response, 200, result);
        return;
      }

      const telegramWebhookRoute =
        request.method === "POST" ? parseTelegramWebhookRoute(requestPathname) : null;

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

            let queuedJob;
            try {
              queuedJob = await enqueueTelegramUpdateJob({
                repositories,
                update: body,
                botKey,
              });
            } catch (error) {
              console.error("telegram update enqueue failed", error);
              sendJson(response, 503, { error: "telegram_update_queue_failed" });
              return;
            }
            if (!queuedJob) {
              sendJson(response, 503, { error: "telegram_update_queue_unavailable" });
              return;
            }
            triggerTelegramUpdateDispatcher?.();

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
        healFailedTelegramUpdates: supervisorHealFailedTelegramUpdates,
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
