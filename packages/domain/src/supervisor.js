const severityRank = {
  ok: 0,
  warning: 1,
  critical: 2,
};

function maxSeverity(left, right) {
  return severityRank[right] > severityRank[left] ? right : left;
}

function asDate(value) {
  return value == null ? null : new Date(value);
}

function isDue(job, now) {
  const runAt = asDate(job.runAt);
  return runAt == null || runAt.getTime() <= now.getTime();
}

function isExpiredRunning(job, now) {
  if (job.status !== "running") return false;
  const lockedUntil = asDate(job.lockedUntil);
  return lockedUntil == null || lockedUntil.getTime() <= now.getTime();
}

function summarizeByType(records) {
  const counts = new Map();
  for (const record of records) {
    const key = record.type ?? record.action ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");
}

function isActiveJob(job) {
  return job.status === "queued" || job.status === "running";
}

function telegramUpdateIdentity(job) {
  if (job.type !== "telegram-update") return null;

  const payload = job.payload ?? {};
  const update = payload.update ?? {};
  const botKey = payload.botKey ?? "default";
  if (update.update_id != null) {
    return `telegram-update:${botKey}:update:${update.update_id}`;
  }

  const messageId = update.message?.message_id;
  const chatId = update.message?.chat?.id;
  if (messageId != null && chatId != null) {
    return `telegram-update:${botKey}:message:${chatId}:${messageId}`;
  }

  return null;
}

function duplicateIdentity(job) {
  const telegramIdentity = telegramUpdateIdentity(job);
  if (telegramIdentity) {
    return telegramIdentity;
  }

  if (job.dedupeKey) {
    return `dedupe:${job.dedupeKey}`;
  }

  return null;
}

function duplicateActiveJobs(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    if (!isActiveJob(job)) continue;

    const identity = duplicateIdentity(job);
    if (!identity) continue;

    const group = groups.get(identity) ?? [];
    group.push(job);
    groups.set(identity, group);
  }

  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .flat();
}

export function analyzeSupervisorState({
  jobs = [],
  auditLogs = [],
  now = new Date(),
  queuedTelegramThreshold = 3,
  failedJobThreshold = 1,
} = {}) {
  const nowDate = new Date(now);
  const dueTelegramUpdates = jobs.filter(
    (job) => job.type === "telegram-update" && job.status === "queued" && isDue(job, nowDate),
  );
  const staleRunningJobs = jobs.filter((job) => isExpiredRunning(job, nowDate));
  const failedJobs = jobs.filter((job) => job.status === "failed");
  const duplicateJobs = duplicateActiveJobs(jobs);
  const staleTelegramDeliveries = staleRunningJobs.filter(
    (job) => job.type === "telegram-delivery",
  );
  const failedTelegramDeliveries = failedJobs.filter(
    (job) => job.type === "telegram-delivery",
  );
  const slowAiLogs = auditLogs.filter((log) => log.action === "ai_response_slow");
  const aiProblemLogs = auditLogs.filter((log) =>
    ["ai_response_failed", "ai_response_empty"].includes(log.action),
  );

  let status = "ok";
  const findings = [];

  if (dueTelegramUpdates.length > queuedTelegramThreshold) {
    status = maxSeverity(status, "warning");
    findings.push({
      severity: "warning",
      code: "telegram_queue_backlog",
      text: `В очереди Telegram накопилось ${dueTelegramUpdates.length} входящих сообщений.`,
      count: dueTelegramUpdates.length,
      autoHeal: false,
    });
  }

  if (staleRunningJobs.length > 0) {
    status = maxSeverity(status, "warning");
    findings.push({
      severity: "warning",
      code: "stale_running_jobs",
      text: `Найдено зависших running jobs: ${staleRunningJobs.length}.`,
      count: staleRunningJobs.length,
      details: summarizeByType(staleRunningJobs),
      autoHeal: true,
    });
  }

  if (staleTelegramDeliveries.length > 0) {
    status = maxSeverity(status, "warning");
    findings.push({
      severity: "warning",
      code: "telegram_delivery_stale",
      text: `Найдены зависшие Telegram delivery jobs: ${staleTelegramDeliveries.length}.`,
      count: staleTelegramDeliveries.length,
      details: summarizeByType(staleTelegramDeliveries),
      autoHeal: false,
    });
  }

  if (failedJobs.length >= failedJobThreshold) {
    status = maxSeverity(status, "critical");
    findings.push({
      severity: "critical",
      code: "failed_jobs",
      text: `Есть failed jobs: ${failedJobs.length}.`,
      count: failedJobs.length,
      details: summarizeByType(failedJobs),
      autoHeal: false,
    });
  }

  if (failedTelegramDeliveries.length > 0) {
    status = maxSeverity(status, "critical");
    findings.push({
      severity: "critical",
      code: "telegram_delivery_failed",
      text: `Есть failed Telegram delivery jobs: ${failedTelegramDeliveries.length}.`,
      count: failedTelegramDeliveries.length,
      details: summarizeByType(failedTelegramDeliveries),
      autoHeal: false,
    });
  }

  if (duplicateJobs.length > 0) {
    status = maxSeverity(status, "warning");
    findings.push({
      severity: "warning",
      code: "duplicate_active_jobs",
      text: `Найдены активные дубли jobs: ${duplicateJobs.length}.`,
      count: duplicateJobs.length,
      details: summarizeByType(duplicateJobs),
      autoHeal: false,
    });
  }

  if (slowAiLogs.length > 0) {
    status = maxSeverity(status, "warning");
    findings.push({
      severity: "warning",
      code: "slow_ai_responses",
      text: `Зафиксированы медленные AI-ответы: ${slowAiLogs.length}.`,
      count: slowAiLogs.length,
      autoHeal: false,
    });
  }

  if (aiProblemLogs.length > 0) {
    status = maxSeverity(status, "warning");
    findings.push({
      severity: "warning",
      code: "ai_response_problems",
      text: `Зафиксированы пустые или ошибочные AI-ответы: ${aiProblemLogs.length}.`,
      count: aiProblemLogs.length,
      details: summarizeByType(aiProblemLogs),
      autoHeal: false,
    });
  }

  return {
    status,
    checkedAt: nowDate.toISOString(),
    metrics: {
      jobsChecked: jobs.length,
      auditLogsChecked: auditLogs.length,
      dueTelegramUpdates: dueTelegramUpdates.length,
      staleRunningJobs: staleRunningJobs.length,
      failedJobs: failedJobs.length,
      duplicateActiveJobs: duplicateJobs.length,
      staleTelegramDeliveries: staleTelegramDeliveries.length,
      failedTelegramDeliveries: failedTelegramDeliveries.length,
      slowAiResponses: slowAiLogs.length,
      aiResponseProblems: aiProblemLogs.length,
    },
    findings,
  };
}

export function formatSupervisorReport(report) {
  const lines = [
    "Supervisor семейного оркестра:",
    `- Статус: ${report.status}.`,
    `- Проверено jobs: ${report.metrics.jobsChecked}; audit logs: ${report.metrics.auditLogsChecked}.`,
    `- Telegram очередь: ${report.metrics.dueTelegramUpdates}; зависшие jobs: ${report.metrics.staleRunningJobs}; failed jobs: ${report.metrics.failedJobs}.`,
    `- Telegram delivery failed: ${report.metrics.failedTelegramDeliveries ?? 0}; дубли active jobs: ${report.metrics.duplicateActiveJobs ?? 0}.`,
  ];

  if (report.findings.length === 0) {
    lines.push("- Сбоев по проверенным сигналам нет.");
    return lines.join("\n");
  }

  lines.push("Найдено:");
  for (const finding of report.findings) {
    lines.push(`- [${finding.severity}] ${finding.text}`);
    if (finding.details) {
      lines.push(`  Детали: ${finding.details}.`);
    }
    if (finding.autoHeal) {
      lines.push("  Безопасное авто-лечение доступно.");
    }
  }

  return lines.join("\n");
}

export function staleJobsForSupervisorRequeue(jobs = [], now = new Date()) {
  const nowDate = new Date(now);
  return jobs.filter((job) => {
    if (!isExpiredRunning(job, nowDate)) return false;
    if (job.type !== "telegram-update") return false;
    return job.result?.stage !== "send";
  });
}

export function failedTelegramUpdateJobsForSupervisorRequeue(jobs = []) {
  return jobs.filter((job) => {
    if (job.type !== "telegram-update") return false;
    if (job.status !== "failed") return false;
    return job.result?.sendWasAttempted !== true;
  });
}
