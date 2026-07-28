import { AiProvider } from "./provider.js";

const defaultKimiBaseUrl = "https://api.moonshot.ai/v1";
const defaultModelByProfile = {
  cheap: "kimi-k2.6",
  standard: "kimi-k2.6",
  strong: "kimi-k3",
  image: "kimi-k3",
};

function trimBaseUrl(baseUrl) {
  return (baseUrl ?? defaultKimiBaseUrl).replace(/\/+$/, "");
}

function resolvePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeKimiText(raw) {
  return raw?.choices?.[0]?.message?.content ?? raw?.answer?.text ?? raw?.text ?? "";
}

async function readErrorBody(response) {
  try {
    const raw = await response.json();
    return raw?.error?.message ?? raw?.message ?? JSON.stringify(raw);
  } catch {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }
}

export class KimiAiProvider extends AiProvider {
  constructor({
    baseUrl = defaultKimiBaseUrl,
    apiKey,
    modelByProfile = {},
    fetchImpl = fetch,
    timeoutMs = 30_000,
    maxCompletionTokens,
    reasoningEffort,
  }) {
    super();
    this.baseUrl = trimBaseUrl(baseUrl);
    this.apiKey = apiKey;
    this.modelByProfile = {
      ...defaultModelByProfile,
      ...modelByProfile,
    };
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxCompletionTokens = resolvePositiveNumber(maxCompletionTokens);
    this.reasoningEffort = reasoningEffort;
  }

  resolveModel(modelProfile, directModel) {
    if (directModel) {
      return directModel;
    }

    const profile = modelProfile?.profile ?? "standard";
    return this.modelByProfile[profile] ?? this.modelByProfile.standard;
  }

  async complete({ modelProfile, messages, model }) {
    if (!this.apiKey) throw new Error("KIMI_AI_API_KEY or MOONSHOT_API_KEY is required");

    const requestBody = {
      model: this.resolveModel(modelProfile, model),
      messages,
      stream: false,
    };

    if (this.maxCompletionTokens) {
      requestBody.max_completion_tokens = this.maxCompletionTokens;
    }

    if (this.reasoningEffort) {
      requestBody.reasoning_effort = this.reasoningEffort;
    }

    let response;
    const controller = new AbortController();
    const timeout =
      Number.isFinite(this.timeoutMs) && this.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : null;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) {
        const timeoutError = new Error(`Kimi AI request timed out after ${this.timeoutMs}ms`, {
          cause: error,
        });
        timeoutError.code = "AI_TIMEOUT";
        throw timeoutError;
      }

      const networkError = new Error(`Kimi AI request network failed: ${error.message}`, {
        cause: error,
      });
      networkError.code = "AI_NETWORK";
      throw networkError;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }

    if (!response.ok) {
      const detail = await readErrorBody(response);
      const error = new Error(
        `Kimi AI request failed with ${response.status}${detail ? `: ${detail}` : ""}`,
      );
      error.status = response.status;
      throw error;
    }

    const raw = await response.json();
    return {
      text: normalizeKimiText(raw),
      raw,
    };
  }
}
