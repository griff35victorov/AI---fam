function resolveSender({ botKey, telegramSender, telegramSenders }) {
  return (botKey ? telegramSenders?.[botKey] : null) ?? telegramSender;
}

async function sendReminderJob({
  payload,
  repositories,
  telegramSender,
  telegramSenders,
  now,
}) {
  const sender = resolveSender({
    botKey: payload.botKey,
    telegramSender,
    telegramSenders,
  });
  if (!sender?.sendMessage) {
    throw new Error("Telegram sender is not configured for reminder job");
  }

  if (!payload.chatId) {
    throw new Error("Reminder job has no Telegram chatId");
  }

  const title = String(payload.title ?? "Напоминание").trim() || "Напоминание";
  await sender.sendMessage({
    chatId: payload.chatId,
    text: `Напоминание: ${title}`,
  });

  if (payload.reminderId && repositories.reminders?.markSent) {
    await repositories.reminders.markSent(payload.reminderId, now);
  }

  return {
    sent: true,
    chatId: payload.chatId,
    reminderId: payload.reminderId,
  };
}

export async function dispatchReminderJobsOnce({
  repositories,
  telegramSender,
  telegramSenders = {},
  now = new Date(),
  maxJobs = 5,
} = {}) {
  if (!repositories?.jobs?.claimNextJob) {
    return { status: "disabled", processed: 0 };
  }

  let processed = 0;
  for (let index = 0; index < maxJobs; index += 1) {
    const job = await repositories.jobs.claim({
      workerId: "api-reminder-dispatcher",
      now,
      lockMs: 60_000,
      dedupeKey: null,
    });
    if (!job) break;

    if (job.type !== "send_reminder") {
      await repositories.jobs.failJob(job, {
        status: "failed",
        error: `Unsupported API dispatcher job type: ${job.type}`,
      }, now);
      processed += 1;
      continue;
    }

    try {
      const result = await sendReminderJob({
        payload: job.payload ?? {},
        repositories,
        telegramSender,
        telegramSenders,
        now,
      });
      await repositories.jobs.completeJob(job, {
        status: "completed",
        ...result,
      }, now);
    } catch (error) {
      await repositories.jobs.failJob(job, {
        status: "failed",
        error: error.message,
      }, now);
    }

    processed += 1;
  }

  return { status: "ok", processed };
}

export function startReminderDispatcher({
  repositories,
  telegramSender,
  telegramSenders = {},
  intervalMs = 30_000,
  now = () => new Date(),
} = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await dispatchReminderJobsOnce({
        repositories,
        telegramSender,
        telegramSenders,
        now: now(),
      });
    } catch (error) {
      console.error("reminder dispatcher failed", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  return () => clearInterval(timer);
}
