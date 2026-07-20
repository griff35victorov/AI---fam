export function createHealthResponse() {
  return {
    status: "ok",
    subsystems: ["api", "database", "ai_provider", "worker"],
  };
}
