import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
  <title>Family AI - резервный чат</title>
  <style>
    :root {
      color-scheme: light;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f3f5f8;
      color: #111827;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100dvh; background: #f3f5f8; color: #111827; }
    main { width: min(960px, 100%); margin: 0 auto; padding: 20px 14px; }
    header { display: grid; gap: 10px; padding: 4px 0 16px; }
    h1 { margin: 0; font-size: clamp(22px, 3vw, 30px); line-height: 1.15; letter-spacing: 0; }
    .status-row { display: flex; flex-wrap: wrap; gap: 8px; }
    .status {
      border: 1px solid #cfd7e3;
      border-radius: 999px;
      background: #ffffff;
      color: #314158;
      padding: 7px 10px;
      font-size: 13px;
      line-height: 1;
    }
    .panel {
      display: grid;
      gap: 12px;
      border: 1px solid #d7dee9;
      border-radius: 8px;
      background: #ffffff;
      padding: 14px;
    }
    .settings {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) minmax(150px, 220px);
      gap: 10px;
    }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 650; color: #314158; }
    input, select, textarea, button {
      min-width: 0;
      font: inherit;
      border: 1px solid #bdc7d6;
      border-radius: 7px;
      padding: 10px 11px;
    }
    input, select, textarea { background: #ffffff; color: #111827; }
    textarea { min-height: 92px; resize: vertical; line-height: 1.4; }
    input:focus, select:focus, textarea:focus {
      outline: 2px solid #2563eb;
      outline-offset: 1px;
      border-color: #2563eb;
    }
    button {
      border-color: #2563eb;
      background: #2563eb;
      color: #ffffff;
      cursor: pointer;
      font-weight: 700;
    }
    button:disabled { opacity: .68; cursor: wait; }
    button:active:not(:disabled) { transform: translateY(1px); }
    #messages {
      display: grid;
      align-content: start;
      gap: 10px;
      min-height: 360px;
      max-height: min(58dvh, 620px);
      overflow: auto;
      border: 1px solid #d7dee9;
      border-radius: 8px;
      background: #f8fafc;
      padding: 12px;
      scroll-behavior: smooth;
    }
    .message {
      width: min(82%, 720px);
      border: 1px solid #d7dee9;
      border-radius: 8px;
      background: #ffffff;
      padding: 10px 12px;
      white-space: pre-wrap;
      line-height: 1.42;
    }
    .message.user {
      justify-self: end;
      border-color: #a8c7ff;
      background: #eaf2ff;
    }
    .message.assistant { justify-self: start; }
    .message.error {
      border-color: #f3b5b5;
      background: #fff1f1;
      color: #7f1d1d;
    }
    .composer {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(160px, 230px) 132px;
      gap: 10px;
      align-items: end;
    }
    .file-input input { padding: 9px 10px; }
    .hint { margin: 0; color: #667085; font-size: 13px; line-height: 1.35; }
    @media (max-width: 700px) {
      main { padding: 12px 10px; }
      .settings, .composer { grid-template-columns: 1fr; }
      #messages { min-height: 45dvh; max-height: 56dvh; }
      .message { width: min(94%, 720px); }
    }
    @media (prefers-color-scheme: dark) {
      :root { color-scheme: dark; background: #111827; color: #eef2f7; }
      body { background: #111827; color: #eef2f7; }
      .panel, .status, input, select, textarea, .message { background: #172033; color: #eef2f7; border-color: #334155; }
      #messages { background: #0f172a; border-color: #334155; }
      .message.user { background: #14315d; border-color: #2f63b4; }
      .message.error { background: #3b1717; border-color: #7f1d1d; color: #fecaca; }
      .hint, label, .status { color: #cbd5e1; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Family AI - резервный чат</h1>
      <div class="status-row" aria-label="Статус каналов">
        <span class="status">Telegram остается основным каналом</span>
        <span class="status">Web идет в тот же оркестр и память</span>
      </div>
    </header>
    <section class="panel">
      <div class="settings">
        <label>Код доступа<input id="code" name="code" type="password" autocomplete="current-password" required></label>
        <label>Профиль<select id="role" name="role">
          <option value="owner">Григорий</option>
          <option value="daughter">Мила</option>
          <option value="teacher">English Teacher AI</option>
        </select></label>
      </div>
      <div id="messages" aria-live="polite">
        <div class="message assistant">Напишите сообщение. Ответ появится здесь и сохранится в той же семейной памяти.</div>
      </div>
      <form id="chat-form" class="composer">
        <label>Сообщение<textarea id="message" name="message"></textarea></label>
        <label class="file-input">Файл или картинка<input id="attachment" name="attachment" type="file" accept=".txt,.md,.markdown,.csv,.json,image/*"></label>
        <button id="send" type="submit">Отправить</button>
      </form>
      <p class="hint">Можно приложить .txt, .md, .csv, .json или изображение. Telegram временно не отвечает - этот чат использует тот же backend напрямую.</p>
    </section>
  </main>
  <script>
    const form = document.getElementById("chat-form");
    const messages = document.getElementById("messages");
    const send = document.getElementById("send");
    const role = document.getElementById("role");
    const savedRole = sessionStorage.getItem("family-ai-role");
    if (savedRole) role.value = savedRole;

    function appendMessage(kind, text) {
      const item = document.createElement("div");
      item.className = "message " + kind;
      item.textContent = text;
      messages.appendChild(item);
      messages.scrollTop = messages.scrollHeight;
      return item;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = document.getElementById("message");
      const code = document.getElementById("code");
      const attachment = document.getElementById("attachment");
      const text = message.value.trim();
      const file = attachment.files && attachment.files.length > 0 ? attachment.files[0] : null;
      if (!text && !file) return;

      sessionStorage.setItem("family-ai-role", role.value);
      appendMessage("user", file ? [text || "Вложение без текста", "Файл: " + file.name].join("\\n") : text);
      message.value = "";
      const pending = appendMessage("assistant", "Готовлю ответ...");
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
        pending.textContent = response.ok
          ? (body.answer && body.answer.text ? body.answer.text : "Пустой ответ")
          : ("Ошибка: " + (body.error || "request_failed"));
        if (response.ok) attachment.value = "";
      } catch (error) {
        pending.className = "message error";
        pending.textContent = "Ошибка связи с backend.";
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
