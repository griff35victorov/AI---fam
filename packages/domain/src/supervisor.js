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
