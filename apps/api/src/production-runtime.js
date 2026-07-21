import { TimewebAiProvider } from "../../../packages/ai/src/index.js";
import { createPrismaRepositories } from "../../../packages/db/src/index.js";
import { createCapabilityRegistry } from "./capabilities.js";
import { TelegramBotSender, TelegramRelaySender } from "./telegram-sender.js";
import { TelegramVoiceTranscriber } from "./voice.js";

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

export function createTelegramSenders(env = {}, fetchImpl = fetch) {
  const senders = {};

  for (const botKey of Object.keys(telegramBotEnv)) {
    const botToken = resolveTelegramBotTokenForKey(env, botKey);
    if (!botToken) {
      continue;
    }

    senders[botKey] = new TelegramBotSender({
      botToken,
      fetchImpl,
    });
  }

  return senders;
}

export function createTelegramBackgroundSenders(env = {}, fetchImpl = fetch) {
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
    });
  }

  return senders;
}

export function createVoiceTranscribers(env = {}, fetchImpl = fetch) {
  const transcriptionUrl = envValue(env.VOICE_TRANSCRIPTION_URL);
  const transcriptionApiKey = envValue(env.VOICE_TRANSCRIPTION_API_KEY);
  if (!transcriptionUrl) {
    return {};
  }

  const transcribers = {};
  for (const botKey of Object.keys(telegramBotEnv)) {
    const botToken = resolveTelegramBotTokenForKey(env, botKey);
    if (!botToken) {
      continue;
    }

    transcribers[botKey] = new TelegramVoiceTranscriber({
      botToken,
      transcriptionUrl,
      transcriptionApiKey,
      fetchImpl,
    });
  }

  return transcribers;
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
  const voiceTranscribers = createVoiceTranscribers(env, fetchImpl);
  const capabilityRegistry = createCapabilityRegistry({
    fetchImpl,
    weatherTimeoutMs: parseNumber(env.WEATHER_TIMEOUT_MS, 6000),
    voiceTranscriber: Object.values(voiceTranscribers)[0],
  });

  return {
    repositories: repositories ?? (prisma ? createPrismaRepositories(prisma) : undefined),
    workspaceId: envValue(env.APP_DEFAULT_WORKSPACE_ID) ?? defaultWorkspaceId,
    capabilityRegistry,
    telegramWebhookSecret: envValue(env.TELEGRAM_WEBHOOK_SECRET),
    telegramWebhookSecrets: parseTelegramWebhookSecrets(env),
    telegramRelayWebhookSecret: envValue(env.TELEGRAM_RELAY_UPSTREAM_SECRET),
    telegramRequireWebhookSecret: parseBoolean(
      env.TELEGRAM_REQUIRE_WEBHOOK_SECRET,
      env.NODE_ENV === "production",
    ),
    telegramReplyMode: envValue(env.TELEGRAM_REPLY_MODE) ?? "webhook_response",
    aiProvider: new TimewebAiProvider({
      baseUrl: envValue(env.TIMEWEB_AI_BASE_URL) ?? defaultTimewebBaseUrl,
      apiKey: envValue(env.TIMEWEB_AI_API_KEY),
      agentIds: parseTimewebAgentIds(env),
      fetchImpl,
    }),
    telegramSender: new TelegramBotSender({
      botToken: resolveTelegramBotToken(env),
      fetchImpl,
    }),
    telegramSenders: createTelegramSenders(env, fetchImpl),
    telegramBackgroundSenders: createTelegramBackgroundSenders(env, fetchImpl),
    voiceTranscribers,
  };
}
