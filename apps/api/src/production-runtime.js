import { TimewebAiProvider } from "../../../packages/ai/src/index.js";
import { createPrismaRepositories } from "../../../packages/db/src/index.js";
import {
  createCapabilityRegistry,
  createPublicWebSearchProvider,
  createWebShoppingProvider,
} from "./capabilities.js";
import { createGoogleWorkspaceProviders } from "./google-workspace.js";
import { LocalTesseractTelegramImageOcr } from "./ocr.js";
import { createLocalTasksProvider } from "./tasks.js";
import { TelegramTextDocumentExtractor } from "./telegram-documents.js";
import {
  TelegramBotSender,
  TelegramFailoverSender,
  TelegramRelaySender,
} from "./telegram-sender.js";
import { LocalVoskTelegramVoiceTranscriber, TelegramVoiceTranscriber } from "./voice.js";

const defaultTimewebBaseUrl = "https://agent.timeweb.cloud";
const defaultWorkspaceId = "workspace-family";
const telegramBotEnv = {
  owner: "TELEGRAM_OWNER_BOT_TOKEN",
  daughter: "TELEGRAM_DAUGHTER_BOT_TOKEN",
  teacher: "TELEGRAM_TEACHER_BOT_TOKEN",
};

function agentProfileFromEnvName(name) {
  return name.toLowerCase();
}

function envValue(value) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function resolveWebChatUrl(env = {}) {
  const explicitUrl = envValue(env.WEB_CHAT_URL);
  if (explicitUrl) return explicitUrl;

  const appUrl =
    envValue(env.WEB_CHAT_PUBLIC_URL) ??
    envValue(env.TIMEWEB_APP_URL) ??
    envValue(env.TIMEWEB_PUBLIC_URL) ??
    envValue(env.APP_PUBLIC_URL);
  if (!appUrl) return "/chat";

  try {
    return new URL("/chat", appUrl).toString();
  } catch {
    return "/chat";
  }
}

function parseBoolean(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}

export function parseTimewebAgentIds(env = {}) {
  const agentIds = envValue(env.TIMEWEB_AGENT_IDS)
    ? JSON.parse(env.TIMEWEB_AGENT_IDS)
    : {};

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("TIMEWEB_AGENT_") || key === "TIMEWEB_AGENT_IDS") {
      continue;
    }

    const agentId = envValue(value);
    if (!agentId) {
      continue;
    }

    const profileName = key.slice("TIMEWEB_AGENT_".length);
    agentIds[agentProfileFromEnvName(profileName)] = agentId;
  }

  return agentIds;
}

function resolveTelegramBotToken(env) {
  return (
    envValue(env.TELEGRAM_BOT_TOKEN) ??
    envValue(env.TELEGRAM_FAMILY_BOT_TOKEN) ??
    envValue(env.TELEGRAM_OWNER_BOT_TOKEN) ??
    envValue(env.TELEGRAM_DAUGHTER_BOT_TOKEN) ??
    envValue(env.TELEGRAM_TEACHER_BOT_TOKEN)
  );
}

function resolveTelegramBotTokenForKey(env, botKey) {
  const envName = telegramBotEnv[botKey];
  return envName ? envValue(env[envName]) : undefined;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTelegramWebhookSecretForKey(env, botKey) {
  const envName = `TELEGRAM_${botKey.toUpperCase()}_WEBHOOK_SECRET`;
  return envValue(env[envName]);
}

export function parseTelegramBotTokens(env = {}) {
  const tokens = {};

  for (const botKey of Object.keys(telegramBotEnv)) {
    const botToken = resolveTelegramBotTokenForKey(env, botKey);
    if (botToken) {
      tokens[botKey] = botToken;
    }
  }

  return tokens;
}

export function createTelegramSenders(env = {}, fetchImpl = fetch, senderOptions = {}) {
  const senders = {};

  for (const botKey of Object.keys(telegramBotEnv)) {
    const botToken = resolveTelegramBotTokenForKey(env, botKey);
    if (!botToken) {
      continue;
    }

    senders[botKey] = new TelegramBotSender({
      botToken,
      fetchImpl,
      ...senderOptions,
    });
  }

  return senders;
}

function createTelegramRelaySenders(env = {}, fetchImpl = fetch, senderOptions = {}) {
  const relayUrl = envValue(env.TELEGRAM_RELAY_URL) ?? envValue(env.TELEGRAM_RELAY_BASE_URL);
  const relaySecret = envValue(env.TELEGRAM_RELAY_SECRET);
  if (!relayUrl || !relaySecret) {
    return {};
  }

  const senders = {};
  for (const botKey of Object.keys(telegramBotEnv)) {
    senders[botKey] = new TelegramRelaySender({
      relayUrl,
      relaySecret,
      botKey,
      fetchImpl,
      ...senderOptions,
    });
  }

  return senders;
}

export function createTelegramBackgroundSenders(env = {}, fetchImpl = fetch) {
  const mode = String(envValue(env.TELEGRAM_BACKGROUND_SEND_MODE) ?? "").toLowerCase();
  const isProduction = envValue(env.NODE_ENV) === "production";
  const allowDirectProductionSend = parseBoolean(
    env.TELEGRAM_ALLOW_DIRECT_BACKGROUND_SEND,
    false,
  );
  const directSenders = createTelegramSenders(env, fetchImpl, {
    maxAttempts: parseNumber(env.TELEGRAM_BACKGROUND_DIRECT_SEND_MAX_ATTEMPTS, 1),
    retryDelayMs: parseNumber(env.TELEGRAM_BACKGROUND_DIRECT_SEND_RETRY_DELAY_MS, 100),
    timeoutMs: parseNumber(env.TELEGRAM_BACKGROUND_DIRECT_SEND_TIMEOUT_MS, 1800),
  });
  const relaySenders = createTelegramRelaySenders(env, fetchImpl, {
    maxAttempts: parseNumber(env.TELEGRAM_BACKGROUND_RELAY_SEND_MAX_ATTEMPTS, 2),
    retryDelayMs: parseNumber(env.TELEGRAM_BACKGROUND_RELAY_SEND_RETRY_DELAY_MS, 250),
    timeoutMs: parseNumber(env.TELEGRAM_BACKGROUND_RELAY_SEND_TIMEOUT_MS, 5000),
  });
  const relayConfigured = Object.keys(relaySenders).length > 0;

  if (isProduction && !relayConfigured && !allowDirectProductionSend) {
    return {};
  }

  if (mode === "direct") {
    return !isProduction || allowDirectProductionSend ? directSenders : {};
  }

  if (mode === "relay") {
    return relaySenders;
  }

  if (mode && mode !== "failover") {
    return relayConfigured ? relaySenders : {};
  }

  if (mode !== "failover" && relayConfigured) {
    return relaySenders;
  }

  if (isProduction && !allowDirectProductionSend) {
    return relaySenders;
  }

  const senders = {};
  for (const botKey of Object.keys(telegramBotEnv)) {
    if (directSenders[botKey] && relaySenders[botKey]) {
      senders[botKey] = new TelegramFailoverSender({
        primary: directSenders[botKey],
        fallback: relaySenders[botKey],
      });
    } else if (directSenders[botKey]) {
      senders[botKey] = directSenders[botKey];
    } else if (relaySenders[botKey]) {
      senders[botKey] = relaySenders[botKey];
    }
  }

  return senders;
}

export function createVoiceTranscribers(env = {}, fetchImpl = fetch) {
  const transcriptionUrl = envValue(env.VOICE_TRANSCRIPTION_URL);
  const transcriptionApiKey = envValue(env.VOICE_TRANSCRIPTION_API_KEY);
  const transcriptionModel = envValue(env.VOICE_TRANSCRIPTION_MODEL);
  const transcriptionLanguage = envValue(env.VOICE_TRANSCRIPTION_LANGUAGE) ?? "ru";
  const provider =
    envValue(env.VOICE_TRANSCRIPTION_PROVIDER) ??
    (transcriptionUrl ? "http" : "local_vosk");

  const transcribers = {};
  for (const botKey of Object.keys(telegramBotEnv)) {
    const botToken = resolveTelegramBotTokenForKey(env, botKey);
    if (!botToken) {
      continue;
    }

    transcribers[botKey] =
      provider === "local_vosk"
        ? new LocalVoskTelegramVoiceTranscriber({
            botToken,
            fetchImpl,
            pythonPath: envValue(env.VOSK_PYTHON_PATH) ?? "python3",
            modelPath: envValue(env.VOSK_MODEL_PATH) ?? "/opt/vosk/model",
            timeoutMs: parseNumber(env.VOSK_TRANSCRIPTION_TIMEOUT_MS, 25_000),
          })
        : new TelegramVoiceTranscriber({
            botToken,
            transcriptionUrl,
            transcriptionApiKey,
            transcriptionModel,
            transcriptionLanguage,
            fetchImpl,
          });
  }

  return transcribers;
}

export function createImageOcrs(env = {}, fetchImpl = fetch) {
  const provider = envValue(env.OCR_PROVIDER) ?? "local_tesseract";
  if (["none", "off", "disabled"].includes(provider.toLowerCase())) {
    return {};
  }

  const imageOcrs = {};
  for (const botKey of Object.keys(telegramBotEnv)) {
    const botToken = resolveTelegramBotTokenForKey(env, botKey);
    if (!botToken) {
      continue;
    }

    imageOcrs[botKey] = new LocalTesseractTelegramImageOcr({
      botToken,
      fetchImpl,
      tesseractPath: envValue(env.TESSERACT_PATH) ?? "tesseract",
      languages: envValue(env.TESSERACT_LANGUAGES) ?? "rus+eng",
      timeoutMs: parseNumber(env.TESSERACT_TIMEOUT_MS, 20_000),
    });
  }

  return imageOcrs;
}

export function createDocumentTextExtractors(env = {}, fetchImpl = fetch) {
  const provider = envValue(env.TELEGRAM_DOCUMENT_TEXT_PROVIDER) ?? "telegram_text";
  if (["none", "off", "disabled"].includes(provider.toLowerCase())) {
    return {};
  }

  const maxBytes = parseNumber(env.TELEGRAM_DOCUMENT_TEXT_MAX_BYTES, 512 * 1024);
  const extractors = {};
  for (const botKey of Object.keys(telegramBotEnv)) {
    const botToken = resolveTelegramBotTokenForKey(env, botKey);
    if (!botToken) {
      continue;
    }

    extractors[botKey] = new TelegramTextDocumentExtractor({
      botToken,
      fetchImpl,
      maxBytes,
    });
  }

  return extractors;
}

function createLocalAutomationProvider({ tasksProvider } = {}) {
  if (!tasksProvider) return undefined;

  return {
    async run() {
      return {
        text: [
          "Локальная автоматизация подключена.",
          "Сейчас активный сценарий: отложенные Telegram-напоминания через PostgreSQL job queue.",
          "Для n8n/Activepieces/Make/webhooks нужен отдельный URL или доступ к выбранному сервису.",
        ].join("\n"),
        source: "automation",
      };
    },
  };
}

export function parseTelegramWebhookSecrets(env = {}) {
  const secrets = {};

  for (const botKey of Object.keys(telegramBotEnv)) {
    const secret = resolveTelegramWebhookSecretForKey(env, botKey);
    if (secret) {
      secrets[botKey] = secret;
    }
  }

  return secrets;
}

export function createProductionDependencies({
  env = process.env,
  repositories,
  prisma,
  fetchImpl = fetch,
} = {}) {
  const resolvedRepositories =
    repositories ?? (prisma ? createPrismaRepositories(prisma) : undefined);
  const voiceTranscribers = createVoiceTranscribers(env, fetchImpl);
  const imageOcrs = createImageOcrs(env, fetchImpl);
  const documentTextExtractors = createDocumentTextExtractors(env, fetchImpl);
  const defaultLocation = envValue(env.APP_DEFAULT_LOCATION) ?? "Москва";
  const defaultTimeZone = envValue(env.APP_DEFAULT_TIME_ZONE) ?? "Europe/Moscow";
  const webSearchProvider = parseBoolean(env.WEB_CURRENT_DATA_ENABLED, true)
    ? createPublicWebSearchProvider({
        fetchImpl,
        timeoutMs: parseNumber(env.WEB_CURRENT_DATA_TIMEOUT_MS, 7000),
      })
    : undefined;
  const tasksProvider = resolvedRepositories?.reminders?.create
    ? createLocalTasksProvider({
        remindersRepository: resolvedRepositories.reminders,
        jobsRepository: resolvedRepositories.jobs,
        defaultTimezone: defaultTimeZone,
      })
    : undefined;
  const shoppingProvider = webSearchProvider
    ? createWebShoppingProvider({ webSearch: webSearchProvider })
    : undefined;
  const automationProvider = createLocalAutomationProvider({ tasksProvider });
  const googleWorkspaceProviders = createGoogleWorkspaceProviders({
    env,
    fetchImpl,
    clock: () => new Date(),
  });
  const telegramPollingBotTokens = parseTelegramBotTokens(env);
  const telegramRelayUrl =
    envValue(env.TELEGRAM_RELAY_URL) ?? envValue(env.TELEGRAM_RELAY_BASE_URL);
  const telegramWebhookIngressMode =
    envValue(env.TELEGRAM_WEBHOOK_INGRESS) ?? (telegramRelayUrl ? "relay" : "direct_or_relay");
  const telegramPollingEmergencyEnabled = parseBoolean(
    env.TELEGRAM_POLLING_EMERGENCY_ENABLED,
    false,
  );
  const telegramPollingEnabled = parseBoolean(
    env.TELEGRAM_POLLING_ENABLED,
    env.NODE_ENV === "production" &&
      Object.keys(telegramPollingBotTokens).length > 0 &&
      !telegramRelayUrl &&
      telegramWebhookIngressMode !== "relay",
  ) && (telegramWebhookIngressMode !== "relay" || telegramPollingEmergencyEnabled);
  const capabilityRegistry = createCapabilityRegistry({
    fetchImpl,
    weatherTimeoutMs: parseNumber(env.WEATHER_TIMEOUT_MS, 6000),
    voiceTranscriber: Object.values(voiceTranscribers)[0],
    webSearch: webSearchProvider,
    calendarProvider: googleWorkspaceProviders.calendarProvider,
    emailProvider: googleWorkspaceProviders.emailProvider,
    tasksProvider,
    ocrProvider: Object.values(imageOcrs)[0],
    shoppingProvider,
    automationProvider,
    materialsRepositoryAvailable: Boolean(resolvedRepositories?.materials?.search),
    telegramConfigured: Boolean(resolveTelegramBotToken(env)),
    defaultLocation,
    defaultTimeZone,
  });

  return {
    repositories: resolvedRepositories,
    workspaceId: envValue(env.APP_DEFAULT_WORKSPACE_ID) ?? defaultWorkspaceId,
    webChatAccessCode: envValue(env.WEB_CHAT_ACCESS_CODE),
    webChatUrl: resolveWebChatUrl(env),
    capabilityRegistry,
    telegramWebhookSecret: envValue(env.TELEGRAM_WEBHOOK_SECRET),
    telegramWebhookSecrets: parseTelegramWebhookSecrets(env),
    telegramRelayWebhookSecret: envValue(env.TELEGRAM_RELAY_UPSTREAM_SECRET),
    telegramWebhookIngressMode,
    telegramRequireWebhookSecret: parseBoolean(
      env.TELEGRAM_REQUIRE_WEBHOOK_SECRET,
      env.NODE_ENV === "production",
    ),
    telegramReplyMode: envValue(env.TELEGRAM_REPLY_MODE) ?? "webhook_response",
    telegramPollingEnabled,
    telegramPollingClearWebhookEnabled: parseBoolean(
      env.TELEGRAM_POLLING_CLEAR_WEBHOOK_ENABLED,
      telegramPollingEnabled,
    ),
    telegramPollingIntervalMs: parseNumber(env.TELEGRAM_POLLING_INTERVAL_MS, 1000),
    telegramPollingErrorDelayMs: parseNumber(env.TELEGRAM_POLLING_ERROR_DELAY_MS, 5000),
    telegramPollingTimeoutSeconds: parseNumber(env.TELEGRAM_POLLING_TIMEOUT_SECONDS, 20),
    telegramPollingBotTokens,
    telegramPollingFetchImpl: fetchImpl,
    telegramAcceptedAckThrottleMs: parseNumber(
      env.TELEGRAM_ACCEPTED_ACK_THROTTLE_MS,
      8000,
    ),
    telegramUpdateQueueEnabled: parseBoolean(
      env.TELEGRAM_UPDATE_QUEUE_ENABLED,
      Boolean(resolvedRepositories?.jobs?.enqueue && resolvedRepositories?.jobs?.claim),
    ),
    telegramUpdateDispatcherIntervalMs: parseNumber(
      env.TELEGRAM_UPDATE_DISPATCHER_INTERVAL_MS,
      1000,
    ),
    telegramUpdateDispatcherMaxJobs: parseNumber(
      env.TELEGRAM_UPDATE_DISPATCHER_MAX_JOBS,
      10,
    ),
    telegramUpdateDispatcherMaxAttempts: parseNumber(
      env.TELEGRAM_UPDATE_DISPATCHER_MAX_ATTEMPTS,
      3,
    ),
    telegramUpdateDispatcherRetryDelayMs: parseNumber(
      env.TELEGRAM_UPDATE_DISPATCHER_RETRY_DELAY_MS,
      5000,
    ),
    reminderDispatcherEnabled: parseBoolean(
      env.REMINDER_DISPATCHER_ENABLED,
      env.NODE_ENV === "production" && Boolean(resolvedRepositories?.jobs?.claim),
    ),
    reminderDispatcherIntervalMs: parseNumber(env.REMINDER_DISPATCHER_INTERVAL_MS, 30_000),
    supervisorEnabled: parseBoolean(
      env.SUPERVISOR_ENABLED,
      env.NODE_ENV === "production" && Boolean(resolvedRepositories?.jobs?.listRecent),
    ),
    supervisorIntervalMs: parseNumber(env.SUPERVISOR_INTERVAL_MS, 60_000),
    supervisorAlertCooldownMs: parseNumber(
      env.SUPERVISOR_ALERT_COOLDOWN_MS,
      10 * 60_000,
    ),
    supervisorAutoHeal: parseBoolean(env.SUPERVISOR_AUTO_HEAL, true),
    supervisorHealFailedTelegramUpdates: parseBoolean(
      env.SUPERVISOR_HEAL_FAILED_TELEGRAM_UPDATES,
      true,
    ),
    supervisorAuditOkTicks: parseBoolean(env.SUPERVISOR_AUDIT_OK_TICKS, false),
    supervisorAuditDedupMs: parseNumber(
      env.SUPERVISOR_AUDIT_DEDUP_MS,
      10 * 60_000,
    ),
    supervisorAlertChatId:
      envValue(env.SUPERVISOR_ALERT_CHAT_ID) ?? envValue(env.TELEGRAM_OWNER_CHAT_ID),
    aiProvider: new TimewebAiProvider({
      baseUrl: envValue(env.TIMEWEB_AI_BASE_URL) ?? defaultTimewebBaseUrl,
      apiKey: envValue(env.TIMEWEB_AI_API_KEY),
      agentIds: parseTimewebAgentIds(env),
      fetchImpl,
      timeoutMs: parseNumber(env.TIMEWEB_AI_TIMEOUT_MS, 30_000),
    }),
    telegramSender: new TelegramBotSender({
      botToken: resolveTelegramBotToken(env),
      fetchImpl,
    }),
    telegramSenders: createTelegramSenders(env, fetchImpl),
    telegramBackgroundSenders: createTelegramBackgroundSenders(env, fetchImpl),
    voiceTranscribers,
    imageOcrs,
    documentTextExtractors,
    tasksProvider,
  };
}
