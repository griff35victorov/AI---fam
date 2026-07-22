import {
  analyzeSupervisorState,
  formatSupervisorReport,
  staleJobsForSupervisorRequeue,
} from "../../../packages/domain/src/index.js";

export async function runSupervisorTick({
  repositories,
  now = new Date(),
  autoHeal = true,
  notifier,
  jobLimit = 200,
  auditLogLimit = 100,
  auditOkTicks = false,
  auditDedupMs = 10 * 60_000,
  staleJobLimit = 100,
} = {}) {
  const jobs = await loadSupervisorJobs({
    repositories,
    now,
    jobLimit,
    staleJobLimit,
  });
  const auditLogs = repositories?.auditLogs?.listRecent
    ? await repositories.auditLogs.listRecent({ limit: auditLogLimit })
    : [];
  const nowDate = new Date(now);

  const healableJobs =
    autoHeal && repositories?.jobs?.rescheduleJob
      ? staleJobsForSupervisorRequeue(jobs, nowDate)
      : [];
  const healedJobs = [];
  for (const job of healableJobs) {
    const healed = await repositories.jobs.rescheduleJob(
      job,
      {
        status: "supervisor_requeued",
        reason: "stale_running_job",
        previousStatus: job.status,
        previousLockedBy: job.lockedBy ?? null,
        previousLockedUntil: job.lockedUntil ?? null,
      },
      nowDate,
      nowDate,
      {
        expectedStatus: "running",
        expectedType: job.type,
        requireStaleLockAt: nowDate,
      },
    );
    if (healed) {
      healedJobs.push(healed);
    }
  }

  const reportJobs =
    healedJobs.length > 0
      ? await loadSupervisorJobs({
          repositories,
          now: nowDate,
          jobLimit,
          staleJobLimit,
        })
      : jobs;
  const report = analyzeSupervisorState({
    jobs: reportJobs,
    auditLogs,
    now: nowDate,
  });

  const shouldNotify = report.status !== "ok" || healedJobs.length > 0;
  const fingerprint = supervisorFingerprint(report, healedJobs, reportJobs);
  const duplicateAudit = hasRecentSupervisorFingerprint({
    auditLogs,
    fingerprint,
    now: nowDate,
    auditDedupMs,
  });

  if (
    repositories?.auditLogs?.create &&
    (auditOkTicks || shouldNotify) &&
    !duplicateAudit
  ) {
    await repositories.auditLogs.create({
      actorId: null,
      action: "supervisor_tick",
      resource: "family-ai-orchestrator",
      metadata: {
        status: report.status,
        metrics: report.metrics,
        findingCodes: report.findings.map((finding) => finding.code),
        autoHealedJobs: healedJobs.length,
        fingerprint,
      },
      createdAt: nowDate,
    });
  }

  if (shouldNotify && typeof notifier === "function") {
    await notifier(formatSupervisorTickMessage({ report, healedJobs }));
  }

  return {
    status: report.status,
    report,
    autoHealedJobs: healedJobs.length,
  };
}

async function loadSupervisorJobs({
  repositories,
  now = new Date(),
  jobLimit = 200,
  staleJobLimit = 100,
} = {}) {
  const [recentJobs, staleJobs] = await Promise.all([
    repositories?.jobs?.listRecent
      ? repositories.jobs.listRecent({ limit: jobLimit })
      : [],
    repositories?.jobs?.listStaleRunning
      ? repositories.jobs.listStaleRunning({ now, limit: staleJobLimit })
      : [],
  ]);
  const jobsById = new Map();
  for (const job of [...recentJobs, ...staleJobs]) {
    jobsById.set(job.id, job);
  }

  return Array.from(jobsById.values());
}

function supervisorFingerprint(report, healedJobs = [], jobs = []) {
  const problemJobIds = jobs
    .filter((job) => job.status === "failed" || job.status === "running")
    .map((job) => `${job.type}:${job.id}:${job.status}`)
    .sort()
    .slice(0, 50);

  return JSON.stringify({
    status: report.status,
    findings: report.findings.map((finding) => ({
      code: finding.code,
      count: finding.count ?? null,
      severity: finding.severity,
    })),
    healedJobIds: healedJobs.map((job) => job.id).sort(),
    problemJobIds,
  });
}

function hasRecentSupervisorFingerprint({
  auditLogs = [],
  fingerprint,
  now = new Date(),
  auditDedupMs = 10 * 60_000,
} = {}) {
  if (!fingerprint || auditDedupMs <= 0) {
    return false;
  }

  const nowTime = new Date(now).getTime();
  return auditLogs.some((log) => {
    if (log.action !== "supervisor_tick") return false;
    if (log.metadata?.fingerprint !== fingerprint) return false;
    const createdAt = new Date(log.createdAt).getTime();
    return Number.isFinite(createdAt) && nowTime - createdAt <= auditDedupMs;
  });
}

export function formatSupervisorTickMessage({ report, healedJobs = [] }) {
  return [
    formatSupervisorReport(report),
    healedJobs.length > 0 ? "" : null,
    healedJobs.length > 0
      ? `Авто-лечение: переотложено зависших задач: ${healedJobs.length}.`
      : null,
  ]
    .filter((line) => line != null)
    .join("\n");
}

export function startSupervisorLoop({
  intervalMs = 60_000,
  alertCooldownMs = 10 * 60_000,
  logger = console,
  auditOkTicks = false,
  ...options
} = {}) {
  let running = false;
  let lastAlertAt = 0;

  const tick = async () => {
    if (running) return;
    running = true;

    try {
      const originalNotifier = options.notifier;
      await runSupervisorTick({
        ...options,
        auditOkTicks,
        notifier:
          typeof originalNotifier === "function"
            ? async (text) => {
                const nowMs = Date.now();
                if (nowMs - lastAlertAt < alertCooldownMs) {
                  return;
                }

                lastAlertAt = nowMs;
                await originalNotifier(text);
              }
            : undefined,
      });
    } catch (error) {
      logger.error?.("supervisor tick failed", error);
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
