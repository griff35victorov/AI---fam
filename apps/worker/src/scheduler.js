const intervalSeconds = Number(process.env.SCHEDULER_INTERVAL_SECONDS ?? 30);

console.log(`family-ai scheduler started with ${intervalSeconds}s interval`);
