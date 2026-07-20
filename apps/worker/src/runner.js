function failureResult(job, error) {
  return {
    status: "failed",
    jobId: job.id,
    type: job.type,
    error: error instanceof Error ? error.message : String(error),
    attempts: (job.attempts ?? 0) + 1,
  };
}

export async function executeJob(job, handlers) {
  const handler = handlers[job.type];

  if (typeof handler !== "function") {
    return failureResult(job, new Error(`Unknown job type: ${job.type}`));
  }

  try {
    const output = await handler(job.payload, job);

    return {
      status: "completed",
      jobId: job.id,
      type: job.type,
      output,
      attempts: job.attempts ?? 0,
    };
  } catch (error) {
    return failureResult(job, error);
  }
}

export async function runWorkerTick(store, handlers, now = new Date()) {
  const job = await store.claimNextJob(now);

  if (!job) return { status: "idle" };

  const result = await executeJob(job, handlers);

  if (result.status === "completed") {
    await store.completeJob(job, result, now);
  } else {
    await store.failJob(job, result, now);
  }

  return result;
}
