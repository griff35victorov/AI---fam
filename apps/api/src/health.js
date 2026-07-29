function normalizeVersion(version = {}) {
  const commitSha = String(
    version.commitSha ??
      process.env.GIT_COMMIT_SHA ??
      process.env.COMMIT_SHA ??
      process.env.SOURCE_VERSION ??
      "",
  ).trim();
  const buildTime = String(
    version.buildTime ??
      process.env.BUILD_TIME ??
      process.env.APP_BUILD_TIME ??
      "",
  ).trim();

  if (!commitSha && !buildTime) return undefined;

  return {
    ...(commitSha ? { commitSha, shortCommitSha: commitSha.slice(0, 7) } : {}),
    ...(buildTime ? { buildTime } : {}),
  };
}

export function createHealthResponse({ version } = {}) {
  const response = {
    status: "ok",
    subsystems: ["api", "database", "ai_provider", "worker"],
  };

  const normalizedVersion = normalizeVersion(version);
  if (normalizedVersion) {
    response.version = normalizedVersion;
  }

  return response;
}

function healthCheck(status, details = {}) {
  return {
    status,
    ...details,
  };
}

function mergeHealthStatus(checks) {
  const statuses = Object.values(checks).map((check) => check.status);
  if (statuses.includes("error")) return "error";
  if (statuses.some((status) => status !== "ok")) return "degraded";
  return "ok";
}

async function checkRepository(name, fn, args) {
  if (typeof fn !== "function") {
    return [name, healthCheck("not_configured")];
  }

  try {
    await fn(args);
    return [name, healthCheck("ok")];
  } catch (error) {
    return [
      name,
      healthCheck("error", {
        error: String(error.message ?? error).slice(0, 160),
      }),
    ];
  }
}

function configuredCheck(isConfigured) {
  return healthCheck(isConfigured ? "ok" : "not_configured");
}

function sanitizeTelegramRuntime(runtime) {
  if (!runtime || typeof runtime !== "object") return undefined;

  const allowedKeys = [
    "webhookIngressMode",
    "replyMode",
    "pollingEnabled",
    "pollingClearWebhookEnabled",
    "updateQueueEnabled",
    "visibleAcceptedAckEnabled",
    "relayConfigured",
    "backgroundSendMode",
    "directBackgroundSendAllowed",
  ];
  const sanitized = {};

  for (const key of allowedKeys) {
    if (runtime[key] !== undefined) {
      sanitized[key] = runtime[key];
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export async function createDeepHealthResponse({
  repositories,
  capabilities = {},
  version,
} = {}) {
  const repositoryChecks = await Promise.all([
    checkRepository("database", repositories?.conversations?.listRecentForActor, { limit: 1 }),
  ]);

  const checks = Object.fromEntries(repositoryChecks);

  if (repositories?.memories?.listForActor) {
    checks.memory = healthCheck("ok");
  } else {
    checks.memory = healthCheck("not_configured");
  }

  checks.materials = configuredCheck(Boolean(repositories?.materials?.search));
  checks.jobs = configuredCheck(Boolean(repositories?.jobs?.listRecent));
  checks.audit_logs = configuredCheck(Boolean(repositories?.auditLogs?.listRecent));
  checks.ai_provider = configuredCheck(Boolean(capabilities.aiProviderConfigured));
  checks.kimi = configuredCheck(Boolean(capabilities.kimiConfigured));
  checks.timeweb = configuredCheck(Boolean(capabilities.timewebConfigured));
  checks.telegram = configuredCheck(Boolean(capabilities.telegramConfigured));
  checks.google_calendar = configuredCheck(Boolean(capabilities.googleCalendarConfigured));
  checks.google_gmail = configuredCheck(Boolean(capabilities.googleGmailConfigured));
  checks.voice = configuredCheck(Boolean(capabilities.voiceTranscriptionConfigured));
  checks.ocr = configuredCheck(Boolean(capabilities.imageOcrConfigured));
  const telegramRuntime = sanitizeTelegramRuntime(capabilities.telegramRuntime);
  if (telegramRuntime) {
    checks.telegram.runtime = telegramRuntime;
  }

  const response = {
    status: mergeHealthStatus(checks),
    checkedAt: new Date().toISOString(),
    checks,
  };

  const normalizedVersion = normalizeVersion(version);
  if (normalizedVersion) {
    response.version = normalizedVersion;
  }

  return response;
}
