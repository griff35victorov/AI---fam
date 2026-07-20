import { AiProvider } from "./provider.js";

export class TimewebAiProvider extends AiProvider {
  constructor({ baseUrl, apiKey, agentIds = {}, fetchImpl = fetch }) {
    super();
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.agentIds = agentIds;
    this.fetchImpl = fetchImpl;
  }

  async complete({ agentProfile, modelProfile, messages, agentId: directAgentId, model }) {
    if (!this.apiKey) throw new Error("TIMEWEB_AI_API_KEY is required");
    const legacyPayload = directAgentId != null || model != null;
    const agentId = directAgentId ?? this.agentIds[agentProfile];
    if (!agentId) throw new Error(`Timeweb agentId is required for agentProfile "${agentProfile}"`);

    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/cloud-ai/agents/${agentId}/call`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messages, model: model ?? modelProfile?.model }),
    });

    if (!response.ok) {
      throw new Error(`Timeweb AI request failed with ${response.status}`);
    }

    const raw = await response.json();
    if (legacyPayload) {
      return raw;
    }

    return {
      text: raw?.answer?.text ?? raw?.text ?? "",
      raw,
    };
  }
}
