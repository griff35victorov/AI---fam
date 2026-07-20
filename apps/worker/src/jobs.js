export function createDueReminderJobs(reminders, now, existingJobs = []) {
  const existingDedupeKeys = new Set(
    existingJobs
      .filter((job) => job.status !== "failed" && job.status !== "cancelled")
      .map((job) => job.dedupeKey),
  );

  return reminders
    .filter((reminder) => reminder.status === "scheduled")
    .filter((reminder) => new Date(reminder.runAt).getTime() <= now.getTime())
    .filter((reminder) => !existingDedupeKeys.has(`send_reminder:${reminder.id}`))
    .map((reminder) => ({
      type: "send_reminder",
      payload: { reminderId: reminder.id },
      dedupeKey: `send_reminder:${reminder.id}`,
      runAt: reminder.runAt,
    }));
}

export function claimNextJob(jobs, now) {
  const available = jobs
    .filter((job) => job.status === "queued")
    .filter((job) => new Date(job.runAt).getTime() <= now.getTime())
    .filter((job) => !job.lockedUntil || new Date(job.lockedUntil).getTime() <= now.getTime())
    .sort((left, right) => new Date(left.runAt).getTime() - new Date(right.runAt).getTime());

  if (available.length === 0) return null;

  return {
    ...available[0],
    status: "running",
  };
}
