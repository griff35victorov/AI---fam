export function createDueReminderJobs(reminders, now) {
  return reminders
    .filter((reminder) => reminder.status === "scheduled")
    .filter((reminder) => new Date(reminder.runAt).getTime() <= now.getTime())
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
    .sort((left, right) => new Date(left.runAt).getTime() - new Date(right.runAt).getTime());

  if (available.length === 0) return null;

  return {
    ...available[0],
    status: "running",
  };
}
