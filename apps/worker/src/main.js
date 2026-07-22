import {
  bootstrapUsersFromEnv,
  createPrismaClient,
  createPrismaRepositories,
} from "../../../packages/db/src/index.js";
import { createTelegramBackgroundSenders } from "../../api/src/production-runtime.js";
import { startSupervisorLoop } from "../../api/src/supervisor-runner.js";

function parseBoolean(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  const supervisorEnabled = parseBoolean(process.env.SUPERVISOR_ENABLED, true);
  console.log("family-ai worker started");

  if (!supervisorEnabled) {
    console.log("supervisor disabled");
    return;
  }

  const prisma = await createPrismaClient();
  await bootstrapUsersFromEnv({ prisma, env: process.env });
  const repositories = createPrismaRepositories(prisma);
  const senders = createTelegramBackgroundSenders(process.env);
  const alertChatId =
    process.env.SUPERVISOR_ALERT_CHAT_ID || process.env.TELEGRAM_OWNER_CHAT_ID;
  const ownerSender = senders.owner;
  const notifier =
    alertChatId && ownerSender?.sendMessage
      ? (text) => ownerSender.sendMessage({ chatId: alertChatId, text })
      : undefined;

  const supervisor = startSupervisorLoop({
    repositories,
    notifier,
    autoHeal: parseBoolean(process.env.SUPERVISOR_AUTO_HEAL, true),
    auditOkTicks: parseBoolean(process.env.SUPERVISOR_AUDIT_OK_TICKS, false),
    auditDedupMs: parseNumber(process.env.SUPERVISOR_AUDIT_DEDUP_MS, 10 * 60_000),
    intervalMs: parseNumber(process.env.SUPERVISOR_INTERVAL_MS, 60_000),
    alertCooldownMs: parseNumber(process.env.SUPERVISOR_ALERT_COOLDOWN_MS, 10 * 60_000),
  });

  const stop = async () => {
    supervisor.stop();
    await prisma.$disconnect?.();
    process.exit(0);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
