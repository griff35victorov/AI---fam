import { TimewebAiProvider } from "../../../packages/ai/src/index.js";
import { createPrismaRepositories } from "../../../packages/db/src/index.js";
import { TelegramBotSender } from "./telegram-sender.js";

const defaultTimewebBaseUrl = "https://agent.timeweb.cloud";
const defaultWorkspaceId = "workspace-family";

function agentProfileFromEnvName(name) {
  return name.toLowerCase();
}

function envValue(value) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
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
    envValue(env.TELEGRAM_TEACHER_BOT_TOKEN)
  );
}

export function createProductionDependencies({
  env = process.env,
  repositories,
  prisma,
  fetchImpl = fetch,
} = {}) {
  return {
    repositories: repositories ?? (prisma ? createPrismaRepositories(prisma) : undefined),
    workspaceId: envValue(env.APP_DEFAULT_WORKSPACE_ID) ?? defaultWorkspaceId,
    telegramWebhookSecret: envValue(env.TELEGRAM_WEBHOOK_SECRET),
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
  };
}
