import { fileURLToPath } from "node:url";

function envValue(value) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function publicBaseUrlFromEnv(env) {
  const value = envValue(env.APP_PUBLIC_URL) ?? envValue(env.APP_BASE_URL);
  if (!value) {
    throw new Error("APP_PUBLIC_URL is required");
  }

  return value.replace(/\/+$/, "");
}

export async function checkProductionHealth({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const url = `${publicBaseUrlFromEnv(env)}/health`;
  const response = await fetchImpl(url, { method: "GET" });
  let body = {};

  try {
    body = await response.json();
  } catch {
    body = {};
  }

  if (!response.ok) {
    throw new Error(`Health check failed with ${response.status}`);
  }

  if (body.status !== "ok") {
    throw new Error("Health check returned a non-ok status");
  }

  return {
    url,
    statusCode: response.status,
    status: body.status,
    subsystems: body.subsystems ?? [],
  };
}

export async function runProductionHealthCli({
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  fetchImpl = fetch,
} = {}) {
  try {
    const summary = await checkProductionHealth({ env, fetchImpl });
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error?.message ?? String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runProductionHealthCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
