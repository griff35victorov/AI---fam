function resolveSender({ botKey, telegramSender, telegramSenders }) {
  return (botKey ? telegramSenders?.[botKey] : null) ?? telegramSender;
}

function reminderDeliveryKey(payload = {}, job = null) {
  if (!payload.chatId) {
    return null;
  }

  const stablePart = payload.reminderId ?? job?.dedupeKey ?? job?.id;
  if (!stablePart) {
    return null;
  }

  return `telegram-reminder:${payload.botKey ?? "default"}:${stablePart}:${payload.chatId}`;
}

async function markReminderSent({ payload, repositories, now }) {
  if (payload.reminderId && repositories.reminders?.markSent) {
    await repositories.reminders.markSent(payload.reminderId, now);
  }
}

async function sendReminderJob({
  job,
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
  const deliveryKey = reminderDeliveryKey(payload, job);
  if (repositories.telegramDeliveries?.claim && deliveryKey) {
    const deliveryClaim = await repositories.telegramDeliveries.claim({
      key: deliveryKey,
      botKey: payload.botKey ?? null,
      updateId: payload.reminderId ?? job?.id ?? null,
      chatId: payload.chatId,
      now,
    });

    if (!deliveryClaim.claimed) {
      await markReminderSent({ payload, repositories, now });
      return {
        sent: false,
        skipped: true,
        reason: "telegram_delivery_already_claimed",
        chatId: payload.chatId,
        reminderId: payload.reminderId,
        deliveryStatus: deliveryClaim.delivery?.status ?? null,
        deliveryStage: deliveryClaim.delivery?.result?.stage ?? null,
      };
    }

    await repositories.telegramDeliveries.markSending?.(deliveryKey, {
      chatId: payload.chatId,
      reminderId: payload.reminderId ?? null,
      botKey: payload.botKey ?? null,
    }, now);
  }

  try {
    await sender.sendMessage({
      chatId: payload.chatId,
      text: `Напоминание: ${title}`,
    });
  } catch (error) {
    if (deliveryKey) {
      await repositories.telegramDeliveries?.markFailed?.(deliveryKey, {
        stage: "send",
        error: error.message,
        chatId: payload.chatId,
        reminderId: payload.reminderId ?? null,
      }, now);
    }
    throw error;
  }

  if (deliveryKey) {
    await repositories.telegramDeliveries?.markSent?.(deliveryKey, {
      stage: "sent",
      chatId: payload.chatId,
      reminderId: payload.reminderId ?? null,
    }, now);
  }
  await markReminderSent({ payload, repositories, now });

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
      type: "send_reminder",
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
        job,
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
