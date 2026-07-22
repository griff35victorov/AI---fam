import { AiProvider } from "./provider.js";

export class TimewebAiProvider extends AiProvider {
  constructor({ baseUrl, apiKey, agentIds = {}, fetchImpl = fetch, timeoutMs = 30_000 }) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.agentIds = agentIds;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async complete({ agentProfile, modelProfile, messages, agentId: directAgentId, model }) {
    if (!this.apiKey) throw new Error("TIMEWEB_AI_API_KEY is required");
    const legacyPayload = directAgentId != null || model != null;
    const agentId = directAgentId ?? this.agentIds[agentProfile];
    if (!agentId) throw new Error(`Timeweb agentId is required for agentProfile "${agentProfile}"`);

    let response;
    const controller = new AbortController();
    const timeout =
      Number.isFinite(this.timeoutMs) && this.timeoutMs > 0
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : null;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/api/v1/cloud-ai/agents/${agentId}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "authorization": `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: model ?? modelProfile?.model ?? "model",
            messages,
            stream: false,
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) {
        throw new Error(`Timeweb AI request timed out after ${this.timeoutMs}ms`, {
          cause: error,
        });
      }

      throw new Error(`Timeweb AI request network failed: ${error.message}`, {
        cause: error,
      });
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }

    if (!response.ok) {
      throw new Error(`Timeweb AI request failed with ${response.status}`);
    }

    const raw = await response.json();
    if (legacyPayload) {
      return raw;
    }

    return {
      text: raw?.choices?.[0]?.message?.content ?? raw?.answer?.text ?? raw?.text ?? "",
      raw,
    };
  }
}
